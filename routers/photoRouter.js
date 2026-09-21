const express = require('express');
const photoRouter = express.Router();
const dotenv = require("dotenv");
dotenv.config();
const multer = require("multer");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const multerS3 = require("multer-s3");
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// multer setup
const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.S3_BUCKET_NAME,
    key: function (req, file, cb) {
      cb(null, Date.now().toString() + "-" + file.originalname);
    },
  }),
});
// const photoController = require('../controllers/photoController');
const { createPhoto,getGalleryPhotos, getRecentPhotos,  deletePhoto, getAllEditedPhotos, updatephoto,deletebulkimage, photoId } = require('../controllers/photoController');
const authorizationMiddleware = require('../middlewares/myAuth');
const requireActiveSubscription = require('../middlewares/requireActiveSubscription');

// Every photo route is paid functionality, so it sits behind the entitlement
// gate as well as auth. Reads stay gated too: otherwise an expired user keeps
// full access to their library, which is the product they stopped paying for.
// Note the gate must run before multer on upload routes, so a blocked request
// does not push a file to S3 first.
photoRouter.post('/create', authorizationMiddleware, requireActiveSubscription, upload.single('file'), createPhoto);
photoRouter.get('/gallery', authorizationMiddleware, requireActiveSubscription, getGalleryPhotos);
photoRouter.get('/recent', authorizationMiddleware, requireActiveSubscription, getRecentPhotos);
photoRouter.get('/all-edits', authorizationMiddleware, requireActiveSubscription, getAllEditedPhotos);

photoRouter.put("/update/:id", authorizationMiddleware, requireActiveSubscription, upload.single('file'), updatephoto);
photoRouter.get("/signlephot/:id", authorizationMiddleware, requireActiveSubscription, photoId);

// Deletions stay available to lapsed users so they can still remove their own
// data after the trial or subscription ends.
photoRouter.delete('/delete/:id', authorizationMiddleware, deletePhoto);
photoRouter.post("/deletebulk", authorizationMiddleware, deletebulkimage);


module.exports = photoRouter;
