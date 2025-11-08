const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');

// Google OAuth2 access token auth middleware
const axios = require('axios');

async function authenticate(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return res.status(401).json({ error: 'Missing or invalid Authorization header' });
	}
	const token = authHeader.split(' ')[1];
	try {
		// Validate access token via Google tokeninfo endpoint
		const response = await axios.get(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
		const payload = response.data;
		// payload.sub is user id, payload.email is email
		req.user = { userId: payload.sub, email: payload.email };
		next();
	} catch (err) {
		return res.status(401).json({ error: 'Invalid Google access token' });
	}
}

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
	serverApi: {
		version: ServerApiVersion.v1,
		strict: true,
		deprecationErrors: true,
	}
});

const app = express();
app.use(bodyParser.json());

	app.use(cors({ origin: ['https://grid-lab1-frontend-7mmt.vercel.app', 'http://localhost:3000'] }));

let notesCollection;

async function startServer() {		
	try {
		await client.connect();
		await client.db("admin").command({ ping: 1 });
		console.log("Pinged your deployment. You successfully connected to MongoDB!");
		notesCollection = client.db("notesapp").collection("notes");

		// Create

		app.post('/notes', authenticate, async (req, res) => {
			try {
				const { Title, Text, notifyAt } = req.body;
				const note = {
					Title,
					Text,
					CreatedAt: new Date(),
					userId: req.user.userId,
					notifyAt: notifyAt ? new Date(notifyAt) : null
				};
				const result = await notesCollection.insertOne(note);
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

		// Read all

		app.get('/notes', authenticate, async (req, res) => {
			try {
				const notes = await notesCollection.find({ userId: req.user.userId }).sort({ CreatedAt: -1 }).toArray();
				res.json(notes);
			} catch (err) {
				res.status(500).json({ error: err.message });
			}
		});

		// Read one

		app.get('/notes/:id', authenticate, async (req, res) => {
			try {
				const note = await notesCollection.findOne({ _id: new ObjectId(req.params.id), userId: req.user.userId });
				if (!note) return res.status(404).json({ error: 'Note not found' });
				res.json(note);
			} catch (err) {
				res.status(500).json({ error: err.message });
			}
		});

		// Update

		app.put('/notes/:id', authenticate, async (req, res) => {
			try {
				const { Title, Text, notifyAt } = req.body;
				const updateFields = {};
				if (Title !== undefined) updateFields.Title = Title;
				if (Text !== undefined) updateFields.Text = Text;
				if (notifyAt !== undefined) updateFields.notifyAt = notifyAt ? new Date(notifyAt) : null;
				const result = await notesCollection.findOneAndUpdate(
					{ _id: new ObjectId(req.params.id), userId: req.user.userId },
					{ $set: updateFields },
					{ returnDocument: 'after' }
				);
				if (!result.value) return res.status(404).json({ error: 'Note not found' });
				res.json(result.value);
			} catch (err) {
				res.status(400).json({ error: err.message });
			}
		});

		// Delete

		app.delete('/notes/:id', authenticate, async (req, res) => {
			try {
				const result = await notesCollection.deleteOne({ _id: new ObjectId(req.params.id), userId: req.user.userId });
				if (result.deletedCount === 0) return res.status(404).json({ error: 'Note not found' });
				res.json({ message: 'Note deleted' });
			} catch (err) {
				res.status(500).json({ error: err.message });
			}
		});

        const port = process.env.PORT || 8080;
				if (req.body.notifyAt !== undefined) updateFields.notifyAt = req.body.notifyAt ? new Date(req.body.notifyAt) : null;
        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });

	} catch (err) {
		console.error(err);
		process.exit(1);
	}
}

startServer();
