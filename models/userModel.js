const mongoose = require('mongoose');
const userModel = mongoose.Schema({
    
    name:{
        type: 'string',
        required: 'true',
    },
    email:{
        type: 'string',
        required: 'true',
        unique: 'true',
        lowercase:'true'
    },
    password:{
        type: 'string',
        required: 'true',
        minlength:8
    },
    trialstartin:{
        type: Date,
        default: Date.now,
    },
    trialendin:{
        type: Date,
        default: null,
    },
    phoneNumber:{
        type: String,
    },
    country:{
        type:'string',
        default:""
    }, 
    countrycode:{
        type:"String",
        default:"+91",
    },
    profileImage: {
        type: String,
        default: ""
      },

    // Subscription
    stripeAccountId: {
        type: String,
        default:"",
    },
    payoutsEnabled: {
        type: Boolean,
        default: false
    },
    externalAccountId: {
        type: String,
        default:"",
    },
        
    account_plan: {
        type: String,
        default:""
    },
    plan_id: {
        type: String,
        default:""
    },
    subscription_id: {
        type: String,
        default:""
    },
    isAdmin:{
        type: Boolean,
        default: false,
    },
    subscription_status: {
        type: String,
        default:"trial"
    },

    // Payment Details
    amount: {
        type: Number,
    },
    currency: {
        type: String,
    },
    payment_method: {
        type: String,
    },
    payment_type: {
        type: String,
        default: 'one-time',
    },
    expiresIn:{
        type:Date,
        default: null,

    },
    success_url: {
        type: String,
        default:null,
    },
    cancel_url: {
        type: String,
        default:null,
    },
    stripeSessionId: {
        type: String,
    },
    confirm: {  
        type: Boolean,
    },
    automatic_payment_methods: {
        enabled: {
            type: Boolean
        },
        allow_redirects: {
            type: String,
        }
    },
    deviceToken:{
        type:String,
        default:""
    },
    language: {
        type: String,
        default: "en",
    },
    lastIntent:{
        type: String,
        default: "",
    },
    subscriptionstartin:{
        type: Date,
        default: Date.now,
    },
    subscriptionendin:{
        type: Date,
        default: null,
    },
    account_type: { type: String, default: "" },

    // --- Subscription lifecycle state (written by the Stripe webhook) ---
    // True once the user asks to cancel but the paid period is still running.
    cancel_at_period_end: {
        type: Boolean,
        default: false,
    },
    subscription_canceled_at: {
        type: Date,
        default: null,
    },
    // Set when an invoice/payment fails, cleared on the next successful payment.
    // Drives the past-due grace window in utils/subscriptionAccess.js.
    payment_failed_at: {
        type: Date,
        default: null,
    },
    last_invoice_id: {
        type: String,
        default: "",
    },
    // Guards against re-sending the trial-ending and trial-ended notifications
    // every time the sweep job runs.
    trial_end_notified_at: {
        type: Date,
        default: null,
    },
    trial_expired_notified_at: {
        type: Date,
        default: null,
    },

}, {timestamps: true});

module.exports = mongoose.model('User', userModel);