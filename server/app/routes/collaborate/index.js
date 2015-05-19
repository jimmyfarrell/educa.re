var router = require('express').Router(),
    Promise = require('bluebird'),
    mkdirp = Promise.promisify(require('mkdirp')),
    git = Promise.promisifyAll(require('gift')),
    fs = Promise.promisifyAll(require('fs')),
    path = require('path'),
    mongoose = require('mongoose'),
    Document = Promise.promisifyAll(mongoose.model('Document')),
    User = Promise.promisifyAll(mongoose.model('User')),
    diff = require('diff'),
    cp = Promise.promisifyAll(require("child_process"));

///creating user's branch
router.post('/branch', function(req, res, next){

    var originalAuthor = req.body.author._id;
    var currentBranch;
    var doc;

    req.body.author = req.user._id;
    req.body.readAccess = [];
    req.body.editAccess = [];
    req.body.branchedFrom = originalAuthor;
    req.body.pullRequests = [];
    delete req.body._id;

    Document.createAsync(req.body)
        .then(function(_doc) {
            doc = _doc;
            return doc.repo.branchAsync();
        })
        .then(function(branch){
            currentBranch = branch;
            // Need to get branch name from currentBranch, maybe currentBranch.name?
            if (currentBranch.name !== originalAuthor) return doc.repo.checkoutAsync(originalAuthor);
            else return;
        })
        .then(function(){
            return doc.repo.create_branchAsync(req.user._id);
        })
        .then(function(){
            return User.findByIdAndUpdateAsync(req.user._id, {$push: {'documents': doc._id}});
        })
        .then(function(){
            res.json(doc);
        })
        .catch(next);

});

//create a pullRequest to the document's original author
router.post('/pullRequest', function(req, res, next){

    var pullRequest = {
        proposedVersion: req.body.document.currentVersion,
        author: req.user._id,
        date: Date.now(),
        message: req.body.message
    };

    Document.findOneAsync({pathToRepo: req.body.document.pathToRepo, author: req.body.document.branchedFrom._id})
        .then(function(doc){
            doc.pullRequests.push(pullRequest);
            return doc.saveAsync();
        })
        .catch(next);

});

//check to see if user is document's author
router.use(function(req, res, next){
    if(req.user._id === req.body.document.author._id) next();
    else next(new Error('Error! You are not authorized.'));
});

//merge another user's proposed changes
router.put('/merge', function(req, res, next){
    var repo =  Promise.promisifyAll(git(req.body.document.pathToRepo));


    repo.checkoutAsync(req.user._id)
        .then(function(){
            var markdownDiff = diff.diffLines(req.body.document.currentVersion, req.body.pullRequest.proposedVersion);
            var xmlFormatted = diff.convertChangesToXML(markdownDiff);
            res.json(xmlFormatted);
        });


});

//is this redundant/inelegant?
router.put('/:docId', function(req, res, next){

    Document.findByIdAndUpdateAsync(req.params.docId, {changedSinceBranch: false})
        .then(function(doc){
            res.json(doc);
        });

});

module.exports = router;
