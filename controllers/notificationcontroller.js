  const Notification= require ("../models/Notification")
const  mongoose=require ('mongoose');
const i18next =require("../config/i18n.js")
const notifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const options = {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      sort: { createdAt: -1 },
      populate: { path: 'sender', select: 'name image' },
    };

    const result = await Notification.paginate({ recipient: userId }, options);

    const responseData = result.docs.map(notification => ({
      _id: notification._id,
      recipient: notification.recipient,
      heading: notification.heading,
      message: notification.message,
      createdAt: notification.createdAt,
      updatedAt: notification.updatedAt,
      requestId: notification.requestId,
      params: notification.params,
      sender: notification.sender
        ? {
            _id: notification.sender._id,
            name: notification.sender.name,
            image: notification.sender.image,
          }
        : null,
    }));

    res.status(200).json({
      status: 'success',
      totalDocs: result.totalDocs,
      totalPages: result.totalPages,
      currentPage: result.page,
      limit: result.limit,
      hasPrevPage: result.hasPrevPage,
      hasNextPage: result.hasNextPage,
      prevPage: result.prevPage,
      nextPage: result.nextPage,
      data: responseData,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: i18next.t('notification.failedToFetch') });
  }
};

// API to delete a single notification
const deletenotifications = async (req, res) => {
  try {
    const { notificationId } = req.params;

    // Validate notificationId before querying the database
    if (!mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).json({ message: i18next.t('deletenotifications.invalidNotificationId') });
    }

    const deletedNotification = await Notification.findByIdAndDelete(notificationId);

    if (!deletedNotification) {
      return res.status(404).json({ message: i18next.t('deletenotifications.notificationNotFound') });
    }

    res.status(200).json({
      status: 'success',
      message: i18next.t('deletenotifications.notificationDeleted'),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: i18next.t('deletenotifications.deleteNotificationError') });
  }
};

// API to delete all notifications for a user
const deletenotificationsbyuser = async (req, res) => {
  try {
    const { userId } = req.params;
    const deletedNotifications = await Notification.deleteMany({ recipient: userId });

    res.status(200).json({
      status: 'success',
      message: i18next.t('deletenotificationsbyuser.notificationsDeleted', { deletedCount: deletedNotifications.deletedCount }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: i18next.t('deletenotificationsbyuser.deleteNotificationsError') });
  }
};
// crearte notification
const createNotification = async (req, res) => {
  try {
    const { recipient, heading, message, sender } = req.body;
    if (!recipient || !message) {
      return res.status(400).json({ error: i18next.t('notification.missingFields') });
    }
    const newNotification = new Notification({
      recipient,
      heading,
      message,
      sender: sender,
    
    });
    await newNotification.save();
    res.status(201).json({
      status: 'success',
      message: i18next.t('notification.created'),
      data: newNotification,
    });
  } catch (error) {
    console.error("Error creating notification:", error);
    res.status(500).json({ error: i18next.t('notification.creationError') });
  }
};


module.exports = {
    notifications,
    deletenotifications,
    deletenotificationsbyuser,
    createNotification
  };
