app.factory('UserFactory', function($http, $q) {
    return {
        createNewUser : function(newUser) {
            return $http.post('/api/user', newUser)
                .then(function(response) {
                    return response.body;
                })
                .catch(function(response) {
                    console.log(response);
                    return $q.reject({message : 'Unable to Sign Up'});
                });
        },
        getUserDocuments: function(userId){
            return $http.get('/api/user/' + userId + '/documents').then(function(response){
                return response.data;
            });
        }
    };
});