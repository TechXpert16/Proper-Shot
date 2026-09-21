const {
    notifications,
    deletenotifications,
    deletenotificationsbyuser,
    createNotification
}=require("../controllers/notificationcontroller")

const router=require("express").Router()
router.get("/getnotification/:userId",notifications)
router.delete("/deletenotification/:notificationId",deletenotifications)
router.delete("/clearnotification/:userId",deletenotificationsbyuser)
router.post("/createnotification",createNotification)
module.exports=router 