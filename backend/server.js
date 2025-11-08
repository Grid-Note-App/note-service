const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const { jwtVerify, createRemoteJWKSet } = require('jose');

//const uri = process.env.MONGODB_URI;
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
// Map of userId -> Set of SSE response objects
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
	for (const res of set) {
		res.write(data);
	}
}

async function verifyGoogleToken(req, res, next) {
	try {
		const auth = req.headers.authorization;
		console.log("Authorization Header:", auth);
		if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

		const token = auth.split(' ')[1];
		console.log("Token to verify:", token);
		const { payload } = await jwtVerify(token, JWKS, {
			issuer: ['https://accounts.google.com', 'accounts.google.com'],
		});
		console.log("Token payload:", payload);

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
		console.log("Pinged your deployment. You successfully connected to MongoDB!");
		notesCollection = client.db("notesapp").collection("notes");

		// Helpful index to speed up queries
		try {
			await notesCollection.createIndex({ userId: 1, remindAt: 1 });
			console.log("Index ensured on userId, remindAt");
		} catch (e) {
			console.warn("Index creation failed (non-fatal):", e.message);
		}

		// Create note
		app.post('/notes', verifyGoogleToken, async (req, res) => {
			try {
				console.log("Create Note Request Body:", req.body);
				console.log("Authenticated User:", req.user);
				const { Title, Text, remindAt } = req.body;
				const note = {
					Title,
					Text,
					CreatedAt: new Date(),
					userId: req.user.sub,
					remindAt: remindAt ? new Date(remindAt) : null
				};
				const result = await notesCollection.insertOne(note);

				// Immediate notification if reminder time is now or in the past
				if (note.remindAt && note.remindAt <= new Date()) {
					sendNotification(note.userId, { type: 'noteDue', id: result.insertedId, Title: note.Title, Text: note.Text });
				}

				res.status(201).json({ id: result.insertedId, ...note });
			} catch (err) {
				res.status(400).json({ error: err.message });
			}
		});

		app.post('/test', async (req, res) => {
			try {
				res.json("test");
			} catch (err) {
				res.status(400).json({ error: err.message });
			}
		});

		// Read all notes
		app.get('/notes', verifyGoogleToken, async (req, res) => {
			try {
				const notes = await notesCollection.find({ userId: req.user.sub }).sort({ CreatedAt: -1 }).toArray();
				res.json(notes);
			} catch (err) {
				res.status(500).json({ error: err.message });
			}
		});

		// Read one note
		app.get('/notes/:id', verifyGoogleToken, async (req, res) => {
			try {
				const note = await notesCollection.findOne({ _id: new ObjectId(req.params.id), userId: req.user.sub });
				if (!note) return res.status(404).json({ error: 'Note not found' });
				res.json(note);
			} catch (err) {
				res.status(500).json({ error: err.message });
			}
		});

		// Update note
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

		// Delete note
		app.delete('/notes/:id', verifyGoogleToken, async (req, res) => {
			try {
				const result = await notesCollection.deleteOne({ _id: new ObjectId(req.params.id), userId: req.user.sub });
				if (result.deletedCount === 0) return res.status(404).json({ error: 'Note not found' });
				res.json({ message: 'Note deleted' });
			} catch (err) {
				res.status(500).json({ error: err.message });
			}
		});

		// SSE notifications stream
		app.get('/notifications/stream', verifyGoogleToken, (req, res) => {
			res.set({
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive'
			});
			res.flushHeaders && res.flushHeaders();
			addClient(req.user.sub, res);
			console.log(`SSE client connected for user ${req.user.sub}. Total: ${sseClients.get(req.user.sub)?.size}`);
			res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
			req.on('close', () => {
				removeClient(req.user.sub, res);
				console.log(`SSE client disconnected for user ${req.user.sub}`);
			});
		});

		// Background poller for due notifications
		setInterval(async () => {
			try {
				const now = new Date();
				const dueNotes = await notesCollection.find({
					remindAt: { $ne: null, $lte: now }
				}).toArray();
				for (const note of dueNotes) {
					sendNotification(note.userId, { type: 'noteDue', id: note._id, Title: note.Title, Text: note.Text });
				}
				if (dueNotes.length) {
					console.log(`Dispatched ${dueNotes.length} due notifications.`);
				}
			} catch (e) {
				console.error("Notification poller error:", e);
			}
		}, 30000); // every 30s

		const port = process.env.PORT || 8080;
		app.listen(port, () => {
			console.log(`Server running on port ${port}`);
		});

	} catch (err) {
		console.error(err);
		process.exit(1);
	}
}

startServer();
