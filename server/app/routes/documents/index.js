var router = require('express').Router(),
    Promise = require('bluebird'),
    mkdirp = Promise.promisify(require('mkdirp')),
    git = Promise.promisifyAll(require('gift')),
    fs = Promise.promisifyAll(require('fs')),
    path = require('path'),
    mongoose = require('mongoose'),
    Document = Promise.promisifyAll(mongoose.model('Document')),
    User = Promise.promisifyAll(mongoose.model('User')),
    diff = require('htmldiff/src/htmldiff.js'),
    cp = Promise.promisifyAll(require("child_process")),
    _ = require('lodash'),
    markdownpdf = require('markdown-pdf'),
    md = require('markdown-it')();


//set a repo for the user
router.use('/', function(req, res, next){
    req.userPath = path.join(__dirname, '/../../../../documents/' + req.user._id);
    next();
});

router.get('/', function(req, res, next){

    var searchObj = {};
    if (req.query.category) searchObj = {category: req.query.category};
    if (req.query.tag) searchObj = {tags: req.query.tag};

    Document.find(searchObj)
    .sort('-likes')
    .populate('author', 'username')
    .execAsync()
        .then(function(docs){
            res.json(docs);
        })
        .catch(next);

});

router.get('/:docId', function(req, res, next){

    Document.findById(req.params.docId)
        .populate("author branchedFrom readAccess editAccess pullRequests.author")
        .exec()
        .then(function(doc){
            res.json(doc);
        });
});

router.get('/:docId/export', function(req, res, next){

    Document.findByIdAsync(req.params.docId)
        .then(function(doc){
                markdownpdf().from.string(doc.currentVersion).to.buffer(function (err, data) {
                    res.setHeader('Content-Type', 'application/pdf');
                    res.send(data);
                });
            });


});

//create client's first folder
router.post('/', function(req, res, next){

    mkdirp(req.userPath)
        .then(function() {
            return createRepo(req);
        })
        .then(function(doc){
            res.send(doc);
        })
        .catch(next);

});

router.param('docId', function(req, res, next) {

    Document.findByIdAsync(req.params.docId)
        .then(function(doc){
            req.doc = doc;
            next();
        })
        .catch(next);

});

router.put('/:docId/likes', function(req, res, next){

    if(req.user.likedDocuments.indexOf(req.doc._id) === -1){
        req.doc.likes++;
        req.user.likedDocuments.push(req.doc._id);
    }
    else {
        if(req.doc.likes > 0) req.doc.likes--;

        req.user.likedDocuments = req.user.likedDocuments.filter(function(doc){
            return doc.toString() !== req.doc._id.toString();
        })
    }

    var tasks = [req.doc.saveAsync(), req.user.saveAsync()];

    Promise.all(tasks)
        .then(function(){
            res.json(req.doc)
        })
        .catch(next);

});


router.put('/:docId/bookmarks', function(req,res,next){

    if(req.user.bookmarks.indexOf(req.doc._id) === -1){
        req.user.bookmarks.push(req.doc._id);
    }
    else {
        var index = req.user.bookmarks.indexOf(req.doc._id);
        req.user.bookmarks.splice(index, 1);
        // return next(new Error("You already have this document in your bookmarks"));
    }

    req.user.saveAsync()
        .then(function(){
            res.json(req.doc);
        })
        .catch(next);
});


router.use(':/docId', function(req, res, next){
    if(req.user._id.toString() === req.doc.author._id.toString() || req.user._id.toString() === req.doc.author.toString()) next();
    else next(new Error('You are not authorized to perform these functions!'));

});


//update a user's file and commit
router.put('/:docId', function(req, res, next){
    var doc;
    var io = require('../../../io')();

    if(req.body.merge > -1) {
        req.doc.pullRequests.splice(req.body.merge, 1);
        alertBranchesOfChange(req)
            .then(function(docs){
                io.emit('successfulMerge');
            });
    }

    //make this more elegant?
    var contentChanged = req.doc.currentVersion !== req.body.document.currentVersion;
    if (contentChanged) req.doc.currentVersion = req.body.document.currentVersion;
    req.doc.tags = req.body.document.tags;
    req.doc.category = req.body.document.category;
    req.doc.title = req.body.document.title;

    req.doc.saveAsync()
        .then(function() {
            if (contentChanged) return updateContent(req);
        })
        .then(function() {
            res.json(req.doc);
        })
        .catch(next);

    function updateContent(req) {
        req.doc.repo.checkoutAsync(req.body.document.author._id)
            .then(function(){
                return fs.writeFileAsync(req.body.document.pathToRepo + '/contents.md', req.body.document.currentVersion);
            })
            .then(function(){
                return req.doc.addAndCommit(req.body.message);
            })
            .catch(next);
    }
});

router.delete('/:docId', function(req, res, next) {

    var doc = req.doc;
    req.doc.removeAsync()
        .then(function() {
            if (doc.branchedFrom) return cp.execAsync('git branch -D ' + req.user._id, {cwd: doc.pathToRepo})
        })
        .then(function() {
            res.sendStatus(200);
        })
        .catch(next);

});

//reset to a previous version
router.put('/:docId/restore/:commitId', function(req, res, next){

    req.doc.repo.checkoutAsync(req.user._id.toString())
        .then(function() {
            return cp.execAsync('git checkout ' + req.params.commitId + " .", {cwd: req.doc.pathToRepo} )
        })
        .then(function(){
            return req.doc.repo.commitAsync('Restored previous version');
        })
        .then(function(){
            return fs.readFileAsync(req.doc.repo.path + '/contents.md');
        })
        .then(function(file){
            req.doc.currentVersion = file.toString();
            return req.doc.saveAsync();
        })
        .then(function(){
            res.json(req.doc);
        })
        .catch(next);

});


router.use('/:docId/commits', require('../commits'));

function createRepo(request) {

    var doc;
    var docPath = '';

    return Document.createAsync(request.body.document)
        .then(function(_doc) {
            doc = _doc;
            doc.dateCreated = Date.now();
            return User.findByIdAndUpdateAsync(request.user._id, {$push: {'documents': doc._id}});
        })
        .then(function() {
            docPath = path.join(request.userPath, '/' + doc._id);
            return mkdirp(docPath);
        })
        .then(function(){
            return fs.writeFileAsync(docPath + '/contents.md', doc.currentVersion);
        })
        .then(function(){
            return git.initAsync(docPath);
        })
        .then(function() {
            doc.pathToRepo = docPath;
            doc.author = request.user._id;
            return doc.saveAsync();
        })
        .then(function() {
            return doc.addAndCommit('First save');
        })
        .then(function(){
            return cp.execAsync("git branch -m master " + request.user._id, {cwd: docPath});
        })
        .then(function(){
            return doc;
        });

}

function alertBranchesOfChange(request){
    var docsToSave = [];

    return Document.findAsync({branchedFrom: request.user._id, pathToRepo: request.body.document.pathToRepo})
        .then(function(docs){
            return Promise.map(docs, function(doc){
                doc.changedSinceBranch = true;
                return doc.saveAsync();
            });
        });
}


module.exports = router;
