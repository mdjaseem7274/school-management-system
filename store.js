// Storage layer. MongoStore is used when MONGODB_URI is set; FileStore is a
// simple fallback for trying the app without a database (data.json).
const fs = require('fs');
const path = require('path');

class FileStore {
  constructor(file) {
    this.file = file;
    this.d = {};
    if (file && fs.existsSync(file)) {
      try { this.d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { this.d = {}; }
    }
  }
  _c(c) { return this.d[c] || (this.d[c] = {}); }
  async all(c) { return Object.entries(this._c(c)).map(([k, v]) => ({ _id: k, ...v })); }
  async get(c, id) { const v = this._c(c)[id]; return v ? { _id: id, ...v } : null; }
  async put(c, id, doc) { const { _id, ...rest } = doc; this._c(c)[id] = rest; this._save(); }
  async del(c, id) { delete this._c(c)[id]; this._save(); }
  _save() {
    if (!this.file) return;
    clearTimeout(this.t);
    this.t = setTimeout(() => fs.writeFileSync(this.file, JSON.stringify(this.d)), 150);
  }
}

class MongoStore {
  constructor(db) { this.db = db; }
  col(c) { return this.db.collection(c); }
  async all(c) { return this.col(c).find({}).toArray(); }
  async get(c, id) { return this.col(c).findOne({ _id: id }); }
  async put(c, id, doc) { const { _id, ...rest } = doc; await this.col(c).replaceOne({ _id: id }, rest, { upsert: true }); }
  async del(c, id) { await this.col(c).deleteOne({ _id: id }); }
}

async function makeStore() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    console.log('Connected to MongoDB');
    return new MongoStore(client.db(process.env.MONGODB_DB || 'school'));
  }
  console.log('MONGODB_URI is not set: using data.json as storage (for trying the app only).');
  return new FileStore(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
}

module.exports = { makeStore, FileStore };
