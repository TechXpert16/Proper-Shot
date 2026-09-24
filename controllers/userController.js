const userModel = require('../models/userModel');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { sendPushNotification } = require("../utils/pushNotification")
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const SecretKey = "hellonodejsfamilythisisoursecretkey";
const otpGenerate = require('../utils/otpGenerate.js');
const generateRandomString = require('../utils/generateRandomString');
const otpResetModel = require('../models/otpResetModel');
const accountMail = require("../utils/sendEmail");
const Notification = require('../models/Notification.js');
const i18next =require("../config/i18n.js")
const appleSignin  =require("apple-signin-auth")
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const photoModel = require('../models/photoModel');
const { getAccessState, newTrialWindow, TRIAL_DAYS } = require('../utils/subscriptionAccess');

const normalizePhoneNumber = (phoneNumber) => {

  if (phoneNumber.startsWith('03')) {
    return phoneNumber.replace(/^03/, '+923');
  }
  if (phoneNumber.startsWith('+92')) {
    return phoneNumber;
  }
  return null;
};
//Signup
const userSignUp = async (req, res) => {  
  try {
    const { 
      name, email, phoneNumber, password, confirmPassword, 
      deviceToken, countrycode, country, language 
    } = req.body;

    const userLanguage = language || 'en'; // Default 'en' if not provided
    await i18next.changeLanguage(userLanguage);

    if (!name || !email || !phoneNumber || !password) {
      return res.status(400).json({ message: i18next.t('signup.fillAllFields') });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const existingPhoneNumberUser = await userModel.findOne({ phoneNumber });
    if (existingPhoneNumberUser) {
      return res.status(400).json({ message: i18next.t('signup.phoneNumberInUse') });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: i18next.t('signup.passwordLength') });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ message: i18next.t('signup.passwordsNotMatch') });
    }

    const existingUser = await userModel.findOne({ email: trimmedEmail });
    if (existingUser) {
      return res.status(400).json({ message: i18next.t('signup.emailInUse') });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const trial = newTrialWindow();

    const newUser = new userModel({
      name,
      email: trimmedEmail,
      phoneNumber,
      password: hashedPassword,
      deviceToken,
      countrycode,
      country,
      language: userLanguage,  // ✅ Save user language
      ...trial,
      subscription_status: 'trial',
    });

    const saveUser = await newUser.save();
    const { password: _, ...userData } = saveUser._doc;

    const accessToken = jwt.sign(
      {
        isAdmin: saveUser.isAdmin,
        _id: saveUser.id,
      },
      process.env.SecretKey,
      { expiresIn: "365d" }
    );

    if (deviceToken) {
      sendPushNotification(
        deviceToken,
        i18next.t('signup.welcomeTitle'),
        i18next.t('signup.welcomeMessage'),
        "WELCOME_NOTIFICATION",
        { trialDays: TRIAL_DAYS }
      );
    }

    const newNotification = new Notification({
      recipient: saveUser._id,
      heading: i18next.t('signup.welcomeTitle'),
      message: i18next.t('signup.welcomeMessage'),
      params: { trialDays: TRIAL_DAYS },
    });
    await newNotification.save();

    // The trial-ended notification used to be a setTimeout scheduled here. That
    // timer only existed in this process's memory, so any restart or deploy lost
    // it, and it never revoked access anyway. jobs/subscriptionSweep.js now
    // expires trials durably from the database.

    return res.status(200).json({
      ...userData,
      accessToken,
      subscription: getAccessState(saveUser),
    });
  } catch (error) {
    console.error("Error in userSignUp:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
//Loign the User
const userLogin = async (req, res) => {
  try {
    const user = await userModel.findOne({
      email: req.body.email.toLowerCase(),
    });

    if (!user) {
      return res.status(401).json({
        code: 401,
        error: i18next.t("login.userNotFound"),
      });
    }

    const comparepass = await bcrypt.compare(req.body.password, user.password);
    if (!comparepass) {
      return res.status(401).json({
        code: 401,
        error: i18next.t("login.invalidPassword"),
      });
    }

    user.deviceToken = req.body.deviceToken;
  if (req.body.language) {
    user.language = req.body.language;
  }
    await user.save();
    await i18next.changeLanguage(user.language);

    const { password, ...others } = user._doc;

    const accessToken = jwt.sign(
      {
        isAdmin: user.isAdmin,
        _id: user.id,
      },
      process.env.SecretKey,
      { expiresIn: "365d" }
    );

    if (user.deviceToken) {
      const title = i18next.t("login.welcomeBack");
      const message = i18next.t("login.loginMessage");
      const type = "login";
      const params = { userId: user._id };

      sendPushNotification(user.deviceToken, title, message, type, params);
    }

    res.status(200).json({
      code: 200,
      message: i18next.t("login.loginSuccess"),
      language: user.language, // ✅ Send language in response
      ...others,
      accessToken,
      subscription: getAccessState(user),
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      code: 500,
      error: "Error Occurred",
    });
  }
};


// controller for getting single user detail
const find = async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await userModel.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json(user);
  } catch (error) {
    console.log("Error : ", error);
    return res.status(500).json({ message: "Server error: " + error.message });
  }
}
//Forgot Password
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    if (!email) {
      return res.status(400).json({ message: i18next.t("forgotPassword.enterEmail") });
    }

    const trimmedEmail = email.trim();
    const lowercaseEmail = trimmedEmail.toLowerCase();
    const user = await userModel.findOne({ email: lowercaseEmail });

    if (!user) {
      return res.status(401).json({ error: i18next.t("forgotPassword.userNotExist") });
    }

    await otpResetModel.deleteMany({ userId: user._id });

    const otp = otpGenerate();
    const resetOtp = new otpResetModel({
      userId: user.id,
      otp,
    });

    await resetOtp.save();
    await accountMail(user.email, "Reset Password OTP", otp);

    res.status(200).json({ message: i18next.t("forgotPassword.resetOTPSent") });

  } catch (error) {
    console.log(error.message);
    res.status(500).json({
      code: 500,
      error: i18next.t("forgotPassword.errorRequestingReset"),
    });
  }
};
//Verify OTP
const VerifyOTP = async (req, res) => {
  try {
    const resetOtp = await otpResetModel.findOne({ otp: req.body.otp });

    if (!resetOtp) {
      return res.status(404).json({ message: i18next.t("verifyOTP.invalidOTP") });
    }

    res.status(200).json({ data: resetOtp });
  } catch (error) {
    res.status(500).json({ error: i18next.t("verifyOTP.serverError") });
  }
};
//Reset Password
const resetPassword = async (req, res) => {
  const password = req.body.password;
  const resetOtp = await otpResetModel.findOne({
    otp: req.body.otp,
    // userId: req.body.userId,
  });
  if (!resetOtp) {
    return res.status(401).json({ message: i18next.t("Invalid OTP") });
  }
  // const salt = await bcrypt.genSalt(15);
  const hashpassword = await bcrypt.hash(password, 10);
  try {
    await userModel.findByIdAndUpdate(resetOtp.userId, {
      $set: {
        password: hashpassword,
      },
    });
    await otpResetModel.deleteMany({ userId: resetOtp.userId });
    return res
      .status(200)
      .json({ message:i18next.t("Password Updated successfully") });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: i18next.t("Error While Reset Password") });
  }

};
//Subscription Module
const subscription = async (req, res) => {
  try {
    const userId = groupid; // or any relevant user identifier

    // Fetch the current user record to get the wallet balance
    const user = await userModel.findById(userId);
    let balance = user.walletBalance;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100,
      currency: "usd",
      payment_method: "pm_card_visa",
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      // Deduct the amount from wallet balance
      balance -= amount;

      // Update wallet balance and group status
      await userModel.findByIdAndUpdate(userId, {
        walletBalance: balance,
        isGroupActive: true
      });
    } else {
    }
  } catch (error) {

  }
}
const loginWithGoogle = async (req, res) => {
  const { idToken, deviceToken, language } = req.body;


  try {
    const decodedToken = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    let user = await userModel.findOne({ email });

    if (!user) {
      user = new userModel({
        name: payload.name,
        email,
        password: Math.random().toString(36).slice(-8),
        profileImage: payload.picture || "",
        deviceToken,
        account_type: "google",
        language: language || "en", 
        // Social signups previously stored no trial dates at all, so with
        // entitlement gating they would have been blocked from day one.
        ...newTrialWindow(),
        subscription_status: 'trial',
      });
      await user.save();
     
      
    } else {
      user.name = payload.name;
      user.profileImage = payload.picture || user.profileImage;
      user.deviceToken = deviceToken || user.deviceToken;
      if (language) {
        user.language = language; // Update language if provided
      }
      await user.save();
    }

    const accessToken = jwt.sign(
      { isAdmin: user.isAdmin || false, _id: user._id },
      process.env.SecretKey,
      { expiresIn: "365d" }
    );

    const { password, ...others } = user._doc;
    // Same access object as email login/signup, so the app routes an expired social
    // account straight to the paywall instead of opening the app first.
    res.status(200).json({ ...others, accessToken, subscription: getAccessState(user) });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: "Error while logging in with Google: " + error.message });
  }
};
const loginWithApple = async (req, res) => {
  const { idToken, deviceToken, language } = req.body;

  try {
    const { email, email_verified } = await appleSignin.verifyIdToken(idToken, {
      audience: process.env.APPLE_CLIENT_ID,
    });

    if (!email) {
      return res.status(400).json({ error: "Unable to retrieve email from Apple ID" });
    }

    if (!email_verified) {
      return res.status(400).json({ error: "Apple ID not verified" });
    }

    let user = await userModel.findOne({ email });

    if (!user) {
      user = new userModel({
        name: email.split("@")[0], 
        email,
        password: Math.random().toString(36).slice(-8),
        profileImage: "", 
        deviceToken,
        account_type: "apple",
        language: language || "en",
        isVerified: true,
        ...newTrialWindow(),
        subscription_status: 'trial',
      });
      await user.save();
    } else {
      user.deviceToken = deviceToken || user.deviceToken;
      if (language) {
        user.language = language; 
      }
      await user.save();
    }

    const accessToken = jwt.sign(
      { isAdmin: user.isAdmin || false, _id: user._id },
      process.env.SecretKey,
      { expiresIn: "365d" }
    );

    const { password, ...others } = user._doc;
    // Same access object as email login/signup, so the app routes an expired social
    // account straight to the paywall instead of opening the app first.
    res.status(200).json({ ...others, accessToken, subscription: getAccessState(user) });
  } catch (error) {
    console.error("Error while logging in with Apple:", error);
    res.status(400).json({ error: "Error while logging in with Apple: " + error.message });
  }
};
// -----------------------admin login------------------------
const dashboard = async (req, res) => {
  try {
    const admins = await userModel.countDocuments({ isAdmin: true });
    const users = await userModel.countDocuments();
    // const books=await Book.countDocuments();
    const usersData = await userModel.find({ isAdmin: false }).select("name email image createdAt");
    res.status(200).json({ admins, users, usersData });
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ code: 500, message: "Error Getting Dashboard Data" });
  }
};
const registerAdmin = async (req, res) => {
  try {
    const checke = await userModel.findOne({ email: req.body.email.toLowerCase() });
    if (checke)
      return res.status(409).json({
        code: 409,
        message: "Admin with this Email Already Exists",
      });
    if (req.body.password !== req.body.confirmpassword)
      return res
        .status(400)
        .json({ code: 400, message: "Passsword Not Matched" });


    const salt = await bcrypt.genSalt(12);
    const hashpassword = await bcrypt.hash(req.body.password, salt);
    const newAdmin = new userModel({
      name: req.body.name,
      email: req.body.email.toLowerCase(),
      password: hashpassword,
      isAdmin: true,
    });
    const savedAdmin = await newAdmin.save();
    res.status(200).json({ code: 200, message: "Admin Registered", savedAdmin });
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message });
  }
};
const Loginadmin = async (req, res) => {
  try {
    const user = await userModel.findOne({
      email: req.body.email.toLowerCase(),
    });
    if (!user) {
      return res.status(401).json({ code: 401, error: "User not found" });
    }
    const comparepass = await bcrypt.compare(req.body.password, user.password);
    if (!comparepass) {
      return res.status(401).json({ code: 401, error: "Invalid Password" });
    }

    const { password, ...others } = user._doc;
    const accessToken = jwt.sign(
      {
        isAdmin: user.isAdmin,
        _id: user.id,
      },
      process.env.SecretKey,
      { expiresIn: "365d" }
    );
    user.deviceToken = req.body.deviceToken
    res.status(200).json({
      code: 200,
      message: "User Loged In Successfully",
      ...others,
      accessToken,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ code: 500, error: "Error Occured" });
  }
};
const allusers = async (req, res) => {
  try {
    const usersData = await userModel.find({ isAdmin: false })
      .select("name email image phoneNumber countrycode createdAt")
      .sort({ createdAt: -1 });
    console.log(usersData);
    res.status(200).json({ usersData });
  } catch (error) {
    res.status(500).json({ code: 500, message: "Error Getting Users Data" });
  }
};
// get single user detail
const GetUserDetails = async (req, res) => {
  try {
    const user = await userModel.findById(req.params.userId)
    if (!user) {
      return res.status(404).json({
        code: 404,
        error: "User Not Found",
      });
    }

    res.status(200).json({ code: 200, message: "User Details", user });
  } catch (error) {
    console.error('Error Getting User Details:', error);
    res.status(500).json({
      code: 500,
      error: "Error Getting User Details: " + error.message,
    });
  }
};
// get all admin
const GetAllAdmins = async (req, res) => {
  try {
    const allAdmins = await userModel.find({
      isAdmin: true,
    }).sort({
      createdAt: -1,
    });
    res.status(200).json({ code: 200, admins: allAdmins });
  } catch (error) {
    res.status(500).json({ code: 500, message: "Error While Getting Admins" });
  }
};
// editt admin
const edittprofile = async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await userModel.findById(userId);
    if (!user) {
      return res.status(404).json({ code: 404, error: "User not found" });
    }

    let updatedFields = req.body;


    const updateUser = await userModel.findByIdAndUpdate(
      userId,
      { $set: updatedFields },
      { new: true }
    );

    if (!updateUser) {
      return res.status(404).json({ code: 404, error: "User not found" });
    }

    res.status(200).json({ code: 200, message: "User updated successfully", user: updateUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ code: 500, error: "Error While Updating Data" });
  }
};
// search by name
const searchUsersByName = async (req, res) => {
  const { name } = req.query;
  try {
    const users = await User.find({ fullname: { $regex: new RegExp(name, 'i') } });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
const deleteadminuser = async (req, res) => {

  try {
    const userId = req.params.userId;
    const user = await userModel.findById(userId);
    if (!user) {
      return res.status(404).json({ code: 404, message: 'User not found' });
    }
    await userModel.findByIdAndDelete(userId);
    res.status(200).json({ code: 200, message: 'User deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ code: 500, message: 'Error while processing request' });
  }
};

const verifyPassword = async (req, res) => {
  try {
    const userId = req.user._id;

    // Check if user exists
    const user = await userModel.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        code: 404, 
        message: i18next.t('deleteUser.userNotFound') 
      });
    }

    
    const comparepass = await bcrypt.compare(req.body.password, user.password);
    if (!comparepass) {
      return res.status(401).json({
        code: 401,
        error: i18next.t("login.invalidPassword"),
      });
    }

    res.status(200).json({ 
      code: 200, 
      message: i18next.t("login.loginSuccess"),

    });

  } catch (error) {
    res.status(500).json({
      code: 500,
      error: "Error Occurred",
    });
  }
};

const deleteUser = async (req, res) => {
  try {
    const userId = req.params.userId;

    // Check if user exists
    const user = await userModel.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        code: 404, 
        message: i18next.t('deleteUser.userNotFound') 
      });
    }

    // Cancel billing whenever there is anything in Stripe to cancel. Gating this
    // on subscription_status === 'active' meant a past_due or trialing customer
    // kept getting invoiced after their account was deleted.
    if (user.stripeAccountId) {
      try {
        if (user.subscription_id && user.subscription_id.startsWith('sub_')) {
          await stripe.subscriptions.cancel(user.subscription_id);
        }
        // Delete the customer from Stripe
        if (user.stripeAccountId) {
          await stripe.customers.del(user.stripeAccountId);
        }
      } catch (stripeError) {
        console.error('Error canceling Stripe subscription:', stripeError);
        // Continue with user deletion even if Stripe operations fail
      }
    }

    // Delete all user's notifications
    await Notification.deleteMany({ recipient: userId });

    // Delete all user's photos
    await photoModel.deleteMany({ userId: userId });

    // Delete any OTP reset records
    await otpResetModel.deleteMany({ userId: userId });

    // Finally, delete the user
    await userModel.findByIdAndDelete(userId);

    res.status(200).json({ 
      code: 200, 
      message: i18next.t('deleteUser.success') 
    });

  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ 
      code: 500, 
      message: i18next.t('deleteUser.error') 
    });
  }
};
module.exports = { userSignUp, userLogin, forgotPassword, VerifyOTP, resetPassword, subscription, find, loginWithGoogle, registerAdmin, dashboard, Loginadmin, allusers, GetUserDetails, GetAllAdmins, edittprofile, searchUsersByName, deleteadminuser, loginWithApple, deleteUser, verifyPassword }