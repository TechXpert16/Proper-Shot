const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');
const NotificationSchema = new mongoose.Schema({
    requestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Buddy',
    },
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    heading: {
        type: String,
    },
    message: {
        type: String,
        required: true
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',

    },
    params: {
        type: Object,
        default: {},
    }

}, {
    timestamps: true
});
NotificationSchema.plugin(mongoosePaginate);
module.exports = mongoose.model("Notification", NotificationSchema);
