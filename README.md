# Delhi Public School Portal (School Management Software)

One shared system for Admin (Principal), Teachers and Students. All data is kept on a server in a
MongoDB database, so every user sees the same data on any phone or computer.

**What it is made of**

- Backend: Node.js + Express (REST API, login with JWT, passwords hashed with bcrypt)
- Database: MongoDB (MongoDB Atlas free tier works)
- Front-end: the same single-page JavaScript app as before (`public/index.html`), now talking to the API.
  It is plain JavaScript, not React.

## Quick start: only 3 things to do

You do not need to run `npm install` yourself when you use Render; it does that while building.

1. **Database (5 minutes):** create a free MongoDB Atlas cluster (steps below) and copy its connection string.
2. **Code:** upload this folder to a new GitHub repository.
3. **Hosting:** on Render choose New, then Blueprint, pick the repository. Render reads `render.yaml` and asks for two values:
   `MONGODB_URI` (the connection string) and `ADMIN_PASSWORD` (the admin password you want). Click Apply and wait for the build.
   Open the link Render gives you and sign in as the admin.

If the Blueprint option gives an error, use "Put it online (Render)" below and type the settings by hand.

## Run on your computer

1. Install Node.js 18 or newer.
2. In this folder run: `npm install`
3. Copy `.env.example` to `.env` and fill in the values (see "MongoDB Atlas" below).
4. Run: `npm start` and open http://localhost:3000

If `MONGODB_URI` is empty, the server stores data in a file called `data.json`. Use that only to try the app.

## MongoDB Atlas (free database)

1. Create a free account and a free cluster at https://www.mongodb.com/atlas
2. Database Access: add a database user (username and password).
3. Network Access: add IP address `0.0.0.0/0` (allow from anywhere), needed for hosting services.
4. Connect, then Drivers: copy the connection string and put it in `MONGODB_URI`. Replace `USER` and `PASSWORD`.

## Put it online (Render, free plan)

1. Upload this folder to a GitHub repository (`.env` is ignored, so your secrets are not uploaded).
2. On https://render.com choose New, Web Service, and pick the repository.
3. Build command: `npm install`   Start command: `npm start`
4. Under Environment add: `MONGODB_URI`, `JWT_SECRET` (long random text), and optionally `ADMIN_ID`, `ADMIN_PASSWORD`.
5. Deploy. Render gives you a link such as `https://your-app.onrender.com`. Give this link to students.
   The free plan sleeps when unused, so the first page load can take about a minute.

## First run

When the database is empty the server creates these accounts. Change the passwords after the first login
(My Account for admin and teacher, Change Password for students).

| Role | ID | Password |
|---|---|---|
| Admin | mdjaseem7274 (or `ADMIN_ID`) | mdjaseem7274@ (or `ADMIN_PASSWORD`) |
| Teacher | guddu7274 | guddu7274@ |
| Students | 3240002, 3240446, 3240447, 3240448, 3240449, 32404450 | 012, 0123, 01234, 012345, 0123456, 01234567 |

Set `ADMIN_PASSWORD` in the environment before the first start so the default admin password is not used.

## How it behaves

- Login is checked on the server. Passwords are stored only as bcrypt hashes and are never sent to the browser.
  The admin cannot read passwords, only set a new one (leave the box empty to keep the old one).
- Each role only receives the data it needs. A student gets only their own records and their class information.
- Rules are enforced on the server too, not only in the screens:
  - teachers cannot create or edit Final Exam tests or marks, cannot change students, fees or the library;
  - students can only add their own leave applications and their own pending fee payments (not more than the pending fee);
  - fee payments become "paid" only when the admin verifies them.
- Pages check the server every 15 seconds, so attendance, notices and results appear on other devices without a reload.
- If two people edit the same record at the same moment, the last save wins.

## Folder

```
server.js        Express app: login, data, sync, account, first-run data
store.js         MongoDB storage (and the data.json fallback)
public/index.html  the application screens
.env.example     settings to copy into .env
```

## API

| Route | Use |
|---|---|
| POST /api/login | role, id, password. Returns a token and the data for that role |
| GET /api/me | restores a session |
| GET /api/data | data for the signed-in role |
| GET /api/version | changes whenever anything is saved |
| POST /api/sync | saves changes (checked against the role) |
| POST /api/account | change own password (and the admin's login ID) |

## Known limits

- Photos, payment screenshots and notice attachments are stored inside MongoDB documents. This is fine for a
  school-sized demo, but for many large files use a file storage service.
- UPI payment still needs the admin to check the screenshot. A payment gateway such as Razorpay needs a merchant
  account and its keys.
- The front-end is not React.
