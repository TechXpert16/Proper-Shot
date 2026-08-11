const photoModel = require("../models/photoModel"); 
const multer = require("multer");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config();
const userModel = require("../models/userModel");
const Notification=require("../models/Notification")
const {sendPushNotification}=require("../utils/pushNotification");
const i18next =require("../config/i18n.js")
const createPhoto = async (req, res) => {
  try {
    const { isEdited, name, capturedAt } = req.body;
    const user = await userModel.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ error: i18next.t("create.userNotFound") });
    }

    if (!req.file || !req.file.location) {
      return res.status(400).json({ error: i18next.t("create.uploadError") });
    }

    // Capture time comes from the device (file mtime). Fall back to now — which equals the
    // old behaviour — when it is absent, unparseable, or implausible. The future-date clamp
    // matters because a device with a wrong clock would otherwise pin a photo to the top of
    // every list permanently; one day of slack absorbs timezone/skew noise.
    const parsed = capturedAt ? new Date(capturedAt) : null;
    const isUsable =
      parsed &&
      !Number.isNaN(parsed.getTime()) &&
      parsed.getTime() <= Date.now() + 24 * 60 * 60 * 1000;

    const UserPictures = new photoModel({
      name,
      userId: req.user.id,
      isEdited,
      capturedAt: isUsable ? parsed : new Date(),
      picture_url: req.file.location,
    });

    await UserPictures.save();

    return res.status(200).json({
      code: 200,
      message: i18next.t("create.pictureUploaded"),
      UserPictures,
    });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ code: 500, error: i18next.t("create.uploadError") });
  }
};

//Get All capture and edited photos....
const getGalleryPhotos = async (req, res) => {
  try {
    // Parse page and limit as integers, with defaults
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    // Fetch the user to verify existence
    const user = await userModel.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error:i18next.t ("User not found") });
    }

    // Set up pagination options
    const options = {
      // Capture order, not upload order. createdAt breaks ties and keeps ordering stable
      // across pages when two photos share a capturedAt.
      sort: { capturedAt: -1, createdAt: -1 },
      lean: true,
      page,
      limit,
    };

    // Fetch paginated gallery photos
    const galleryPhotos = await photoModel.paginate(
      { userId: req.user.id, isEdited: false },
      options
    );

    // Check if any photos exist for the user
    if (!galleryPhotos.docs || galleryPhotos.docs.length === 0) {
      return res.status(200).json({
        message: i18next.t("gallery.noPhotosFound"),
        galleryPhotos: [],
        totalPages: galleryPhotos.totalPages || 0,
        currentPage: galleryPhotos.page,
        totalDocs: galleryPhotos.totalDocs || 0,
      });
    }

    // Return the paginated photos
    return res.status(200).json({
      message: i18next.t("gallery.allPhotos"),
      galleryPhotos: galleryPhotos.docs,
      totalPages: galleryPhotos.totalPages,
      currentPage: galleryPhotos.page,
      totalDocs: galleryPhotos.totalDocs,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};


const getRecentPhotos = async (req, res) => {
  try {
    // Parse and ensure valid pagination values
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 10, 1);
    
    // Check if user exists
    const user = await userModel.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: i18next.t("recent.userNotFound") });
    }

    // Pagination options
    const options = {
      // Capture order, not upload order. createdAt breaks ties and keeps ordering stable
      // across pages when two photos share a capturedAt.
      sort: { capturedAt: -1, createdAt: -1 },
      lean: true,
      page,
      limit
    };

    // Fetch paginated recent photos
    const recentPhotos = await photoModel.paginate({ userId: req.user.id, isEdited: false }, options);

    // Handle no photos found
    if (!recentPhotos.docs.length) {
      return res.status(200).json({
        message: i18next.t("recent.noRecentPhotos"),
        recentPhotos: [],
        totalPages: recentPhotos.totalPages || 0,
        currentPage: recentPhotos.page,
        totalDocs: recentPhotos.totalDocs || 0,
      });
    }

    // Return paginated recent photos
    return res.status(200).json({
      message: i18next.t("recent.recentPhotos"),
      recentPhotos: recentPhotos.docs,
      totalPages: recentPhotos.totalPages,
      currentPage: recentPhotos.page,
      totalDocs: recentPhotos.totalDocs,
    });
  } catch (err) {
    console.error("Error fetching recent photos:", err);
    return res
      .status(500)
      .json({ error: i18next.t("recent.serverError") || err.message });
  }
};
//get all edited photos....
const getAllEditedPhotos = async (req, res) => {
  try {
    // Ensure valid pagination values
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 10, 1);

    // Check if user exists
    const user = await userModel.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: i18next.t("edited.userNotFound") });
    }

    // Pagination options
    const options = {
      // Was `updatedAt: -1`, which is MUTABLE — renaming a photo (updatephoto) bumps
      // updatedAt, so any rename jumped that photo to the top of "All Your Edits". Sorted by
      // capture time instead, matching the other two lists and the client's request for
      // "the order in which they were taken".
      sort: { capturedAt: -1, createdAt: -1 },
      lean: true,
      page,
      limit
    };

    // Fetch paginated edited photos
    const editedPhotos = await photoModel.paginate({ userId: req.user.id, isEdited: true }, options);

    // Handle no edited photos found
    if (!editedPhotos.docs.length) {
      return res.status(200).json({
        message: i18next.t("edited.noEditedPhotos"),
        editedPhotos: [],
        totalPages: editedPhotos.totalPages || 0,
        currentPage: editedPhotos.page,
        totalDocs: editedPhotos.totalDocs || 0
      });
    }

    // Return paginated edited photos
    return res.status(200).json({
      message: i18next.t("edited.allEditedPhotos"),
      editedPhotos: editedPhotos.docs,
      totalPages: editedPhotos.totalPages,
      currentPage: editedPhotos.page,
      totalDocs: editedPhotos.totalDocs
    });
  } catch (err) {
    console.error("Error fetching edited photos:", err);
    return res
      .status(500)
      .json({ error: i18next.t("edited.serverError") || err.message });
  }
};

const deletePhoto = async (req, res) => {
  try {
    const { id: photoId } = req.params;

    // Validate user existence
    const user = await userModel.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: i18next.t("delete.userNotFound") });
    }

    // Fetch the photo
    const photo = await photoModel.findById(photoId);
    if (!photo) {
      return res.status(404).json({ message: i18next.t("delete.photoNotFound") });
    }

    // Ensure user owns the photo before deletion (security check)
    if (photo.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: i18next.t("delete.unauthorized") });
    }

    // Delete the photo
    await photoModel.findByIdAndDelete(photoId);

    return res.status(200).json({ message: i18next.t("delete.photoDeleted") });

  } catch (error) {
    console.error("Error deleting photo:", error);
    return res.status(500).json({ message: i18next.t("delete.serverError") || error.message });
  }
};
// controller for delete multiple image
const deletebulkimage=async(req,res)=>{
  try {
    const photoIds = req.body.photoIds;
    const user = await userModel.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: i18next.t('deleteBulk.userNotFound') });

    }
    const deletedPhotos = await photoModel.deleteMany({ userId: req.user.id, _id: { $in: photoIds } });
    if (deletedPhotos.deletedCount === 0) {
      return res.status(404).json({ message:i18next.t('deleteBulk.photoNotFound') });
    }
    return res.status(200).json({ message:i18next.t ('deleteBulk.photosDeleted') });
  } catch (error) {
    console.log("Error: ", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
}
// update photo
const updatephoto = async (req, res) => {
  try {
    const { isEdited, name } = req.body;
    const photoId = req.params.id;
    const user = await userModel.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ error: i18next.t('photo.update.userNotFound') });
    }

    let photo = await photoModel.findById(photoId);
    if (!photo) {
      return res.status(404).json({ error: i18next.t('photo.update.photoNotFound') });
    }

    if (photo.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: i18next.t('photo.update.unauthorized') });
    }

    if (name) {
      photo.name = name;
    }

    if (typeof isEdited !== "undefined") {
      photo.isEdited = isEdited;
    }

    // Handle new file upload if provided
    if (req.file) {
      photo.picture_url = req.file.location;
    }

    await photo.save();

    // Prepare notification message and title
    const notificationMessage = i18next.t('photo.update.photoUpdatedMessage');
    const notificationTitle = i18next.t('photo.update.photoUpdatedTitle');
    const notificationParams = { photoId: photo._id };

    // In-App Notification
    const newNotification = new Notification({
      recipient: user._id,  // The user is the recipient
      heading: notificationTitle,
      message: notificationMessage,
      sender: null,
      params: notificationParams
    });

    // Save in-app notification to database
    await newNotification.save();

    // Push Notification
    if (user.deviceToken) {
      sendPushNotification(
        user.deviceToken,
        notificationTitle,
        notificationMessage,
        "PHOTO_UPDATE_NOTIFICATION",
        notificationParams
      );
    }

    return res.status(200).json({ code: 200, message: i18next.t('photo.update.photoUpdated'), photo });
  } catch (error) {
    console.error("Error While Updating Photo:", error);
    res.status(500).json({ code: 500, error: i18next.t('photo.update.updateError') });
  }
};



const photoId=async (req,res)=>{
  try {
    const photoId = req.params.id;
    const photo = await photoModel.findById(photoId);
    if (!photo) {
      return res.status(404).json({ message:i18next.t('getById.photoNotFound') });
    }
    res.status(200).json(photo);
  } catch (error) {
    return res.status(500).json({ message:i18next.t('getById.serverError') });
  }
}

module.exports = { createPhoto, getRecentPhotos, getGalleryPhotos,getAllEditedPhotos,  deletePhoto,updatephoto,deletebulkimage,photoId  };

