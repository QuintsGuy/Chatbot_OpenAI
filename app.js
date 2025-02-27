//example using socket.io
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

//Setup static folder
app.use(express.static("public"));
const users = new Set();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"

const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 30 * 1000;
const MAX_REQUESTS = 10;

function isRateLimited(socketId) {
    const now = Date.now();
    if (!rateLimit.has(socketId)) {
        rateLimit.set(socketId, [])
    }

    const timestamps = rateLimit.get(socketId).filter(time => now - time < RATE_LIMIT_WINDOW);
    if (timestamps.length >= MAX_REQUESTS) {
        return true;
    }
    
    timestamps.push(now);
    rateLimit.set(socketId, timestamps);
    return false;
}

async function getAIResponse(userMessage, retryCount = 0) {
    try {
        const response = await axios.post(
            OPENAI_ENDPOINT,
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: userMessage }],
            },
            {
                headers: {
                    "Authorization": `Bearer ${OPENAI_API_KEY}`,
                    "Content-Type": "application/json"
                },
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn("Rate limit hit. Retrying...");
            if (retryCount < 3) {  // Retry up to 3 times
                await new Promise(resolve => setTimeout(resolve, 2000 * (retryCount + 1))); // Exponential backoff
                return getAIResponse(userMessage, retryCount + 1);
            }
            return "I'm currently handling too many requests. Try again later!";
        }
        console.error("Error fetching AI response:", error);
        return "Sorry, I couldn't process that.";
    }
}

//Actual Socket.io application
io.on("connection",(socket)=>{
    console.log("A new user connected to the server.");

    socket.on("chat message", async (msg)=>{
        const username = socket.username || "Anonymous";
        console.log(`Message from ${socket.username}: ${msg}`);
        io.emit("chat message", `${socket.username}: ${msg}`);

        if (isRateLimited(socket.id)) {
            console.warn(`User ${username} is rate-limited.`);
            socket.emit("chat message", "🤖 Bot: You're sending too many requests! Please wait.");
            return;
        }

        // If message is directed to the bot ("@bot" prefix)
        if (msg.toLowerCase().startsWith("@bot")) {
            console.log(`Calling OpenAI API for message: ${msg}`);
            const botResponse = await getAIResponse(msg.replace("@bot", "").trim());
            console.log(`OpenAI Response: ${botResponse}`);

            socket.emit("chat message", `🤖 Bot: ${botResponse}`);
        }
    });

    //Set the username
    socket.on("set username", (username)=>{
        socket.username = username;
        users.add(username);
        socket.emit("user list", Array.from(users));
        io.emit("chat message", `🔵 ${username} has joined the chat.`)
    });

    socket.on("disconnect", () => {
        console.log(`User disconnected: ${socket.username || "Unknown"}`);
        users.delete(socket.username);
        io.emit("user list", Array.from(users));
        io.emit("chat message", `🔴 ${socket.username || "Unknown"} has left the chat.`);
    });
});

server.listen(3000, ()=>{
    console.log("Server running on port 3000")
});