const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const { jwtVerify, createRemoteJWKSet } = require('jose');

const uri = "mongodb+srv://ia03nelepindmitriy_db_user:QRQVcqXo7L97W2jX@gridnotes.8qulvdy.mongodb.net/?retryWrites=true&w=majority&appName=GRIDNotes";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

if (!uri) {
	console.error('FATAL: MONGODB_URI environment variable is not set.');
	process.exit(1);
}

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: ['https://grid-lab1-frontend-7mmt.vercel.app', 'http://localhost:3000'] }));

let notesCollection;
const sseClients = new Map();

function addClient(userId, res) {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId).add(res);
}

function removeClient(userId, res) {
  const set = sseClients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(userId);
}

function sendNotification(userId, payload) {
  const set = sseClients.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of Array.from(set)) {
    try {
      res.write(data);
    } catch (e) {
      try { res.end(); } catch {}
      set.delete(res);
    }
  }
  if (!set.size) sseClients.delete(userId);
}

async function verifyGoogleToken(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

    const token = auth.split(' ')[1];
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    });

    req.user = payload;
    next();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    res.status(401).json({ error: 'Invalid Google ID token' });
  }
}

async function startServer() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
    notesCollection = client.db("notesapp").collection("notes");

    await notesCollection.createIndex({ userId: 1, remindAt: 1 });

    // CREATE NOTE
    app.post('/notes', verifyGoogleToken, async (req, res) => {
      try {
        const { Title, Text, remindAt } = req.body;
        const note = {
          Title,
          Text,
          CreatedAt: new Date(),
          userId: req.user.sub,
          remindAt: remindAt ? new Date(remindAt) : null,
          notified: false
        };
        const result = await notesCollection.insertOne(note);

        // immediate send if reminder is now or past
        if (note.remindAt && note.remindAt <= new Date()) {
          sendNotification(note.userId, { type: 'noteDue', id: result.insertedId, Title: note.Title, Text: note.Text });
          await notesCollection.updateOne({ _id: result.insertedId }, { $set: { notified: true, notifiedAt: new Date() } });
        }

        res.status(201).json({ id: result.insertedId, ...note });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // READ ALL NOTES
    app.get('/notes', verifyGoogleToken, async (req, res) => {
      try {
        const notes = await notesCollection.find({ userId: req.user.sub }).sort({ CreatedAt: -1 }).toArray();
        res.json(notes);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // READ ONE
    app.get('/notes/:id', verifyGoogleToken, async (req, res) => {
      try {
        const note = await notesCollection.findOne({ _id: new ObjectId(req.params.id), userId: req.user.sub });
        if (!note) return res.status(404).json({ error: 'Note not found' });
        res.json(note);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // UPDATE
    app.put('/notes/:id', verifyGoogleToken, async (req, res) => {
      try {
        const { Title, Text, remindAt } = req.body;
        const updateFields = {};
        if (Title !== undefined) updateFields.Title = Title;
        if (Text !== undefined) updateFields.Text = Text;
        if (remindAt !== undefined) updateFields.remindAt = remindAt ? new Date(remindAt) : null;
        const result = await notesCollection.findOneAndUpdate(
          { _id: new ObjectId(req.params.id), userId: req.user.sub },
          { $set: updateFields },
          { returnDocument: 'after' }
        );
        if (!result.value) return res.status(404).json({ error: 'Note not found' });
        res.json(result.value);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // DELETE
    app.delete('/notes/:id', verifyGoogleToken, async (req, res) => {
      try {
        const result = await notesCollection.deleteOne({ _id: new ObjectId(req.params.id), userId: req.user.sub });
        if (result.deletedCount === 0) return res.status(404).json({ error: 'Note not found' });
        res.json({ message: 'Note deleted' });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

	app.get('/notifications/stream', verifyGoogleToken, (req, res) => {
	res.set({
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no'
	});
	res.flushHeaders && res.flushHeaders();

	const userId = req.user.sub;

	if (sseClients.has(userId)) {
		for (const oldRes of sseClients.get(userId)) {
		try {
			oldRes.write(`event: close\ndata: {}\n\n`);
			oldRes.end();
		} catch {}
		}
		sseClients.delete(userId);
	}

	addClient(userId, res);
	console.log(`SSE connected for ${userId}`);
	res.write(`retry: 5000\n`);
	res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);

	const CONNECTION_TTL_MS = 20000;
	const ttlTimer = setTimeout(() => {
		try {
		res.write(`event: close\ndata: {"reason":"ttl"}\n\n`);
		res.end();
		} catch {}
	}, CONNECTION_TTL_MS);

	const cleanup = () => {
		clearTimeout(ttlTimer);
		removeClient(userId, res);
		console.log(`SSE disconnected for ${userId}`);
	};

	req.on('close', cleanup);
	req.on('finish', cleanup);
	req.on('error', cleanup);
	});
    
    setInterval(async () => {
      try {
        const now = new Date();
        const dueNotes = await notesCollection.find({
          remindAt: { $ne: null, $lte: now },
          notified: { $ne: true }
        }).toArray();

        for (const note of dueNotes) {
          sendNotification(note.userId, { type: 'noteDue', id: note._id, Title: note.Title, Text: note.Text });
          await notesCollection.updateOne({ _id: note._id }, { $set: { notified: true, notifiedAt: new Date() } });
        }

        if (dueNotes.length) {
          console.log(`Sent ${dueNotes.length} reminders.`);
        }
      } catch (e) {
        console.error("Notification poller error:", e);
      }
    }, 5000);

    const port = process.env.PORT || 8081;
    app.listen(port, () => console.log(`Server running on port ${port}`));

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

startServer();
