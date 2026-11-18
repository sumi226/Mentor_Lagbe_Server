Import express from ‘express’
const app = express()
const PORT = 8000
Const client = new MongoClient(process.env.MONGO_URI)