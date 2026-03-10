const express = require('express');
const {
    userLogin,
    userSignUp,
    forgotPassword,
    VerifyOTP,
    resetPassword,
    find,
    loginWithGoogle,
    registerAdmin,
    dashboard,
    Loginadmin,
    allusers,
    GetUserDetails,
    GetAllAdmins,
    edittprofile,
    searchUsersByName,
    deleteadminuser,
    loginWithApple,
    deleteUser,
    verifyPassword,
} = require('../controllers/userController');
const authorizationMiddleware = require('../middlewares/myAuth');
// const authorizationMiddleware = require('../middlewares/myAuth');
// const subscription = require('../controllers/subscriptionController');
const userRouter = express.Router();

//user
userRouter.post('/signup', userSignUp);
userRouter.post('/login', userLogin);
userRouter.get('/singleuser/:id', find);

//password routes
userRouter.post('/forgot-password', forgotPassword);
userRouter.post('/verify-otp', VerifyOTP);
userRouter.post('/reset-password', resetPassword);
userRouter.post('/google-sign', loginWithGoogle);
userRouter.get('/getdashboard', dashboard);
userRouter.post('/registeradmin', registerAdmin);
userRouter.post('/loginadmin', Loginadmin);
userRouter.get('/getalluser', allusers);
userRouter.get('/getUserById/:userId', GetUserDetails);
userRouter.get('/getalladmin', GetAllAdmins);
userRouter.put('/edittadmin/:userId', edittprofile);
userRouter.get('/search', searchUsersByName);
userRouter.delete('/deleteadmin/:userId', deleteadminuser);
userRouter.post('/login-with-apple', loginWithApple);
userRouter.post('/verify-pass', authorizationMiddleware, verifyPassword);

// Delete user and all related data
userRouter.delete('/delete/:userId', authorizationMiddleware, deleteUser);

module.exports = userRouter;
