# Use official Node.js LTS image
FROM node:24

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the app
COPY . .

# Expose the port (default 8080)
EXPOSE 8080

# Start the server
CMD ["npm", "start"]
