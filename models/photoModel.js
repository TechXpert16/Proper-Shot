const mongoose = require("mongoose");
const mongoosePaginate = require('mongoose-paginate-v2');
const photoSchema = new mongoose.Schema({
  name:{
    type:String,
    default:"",
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  isEdited: { type: Boolean, default: false },

  // When the photo was TAKEN on the device, as reported by the client.
  //
  // `createdAt` (from timestamps) is the DB insert time, i.e. UPLOAD time. Those differ
  // whenever photos are queued offline and uploaded later as a batch, so ordering by
  // createdAt showed the client's photos in upload order rather than capture order — the
  // "photos appear completely mixed up" report. Defaults to now so a client that doesn't
  // send capturedAt behaves exactly as before.
  capturedAt: { type: Date, default: Date.now },

  picture_url: {type: String},
},
{timestamps: true});

// The list endpoints all filter on userId + isEdited and sort by capturedAt. Without this
// compound index Mongo must sort the whole matching set in memory for every paginated page.
photoSchema.index({ userId: 1, isEdited: 1, capturedAt: -1 });

photoSchema.plugin(mongoosePaginate);
module.exports = mongoose.model("Photo", photoSchema);
