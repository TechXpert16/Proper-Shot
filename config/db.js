const mongoose = require('mongoose')
require('dotenv').config()

// .env defines MONGODB_URI, but this file only ever read DB_URL — so the URI was
// undefined and the connection silently failed on boot. Accept either name.
const uri = process.env.DB_URL || process.env.MONGODB_URI;

if (!uri) {
    console.error("Database Not Connected: set DB_URL or MONGODB_URI");
}

const connection = mongoose.connect(uri);
connection.then(()=>{
    console.log("Database Connected Successfully !");
}).catch((e)=>{
    console.log("Database Not Connected", e)
})

module.exports = connection;
