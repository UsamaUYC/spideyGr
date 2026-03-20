require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const admin = require("firebase-admin");
const fs = require("fs");
const express = require("express");

const app = express();
const processed = new Set();

// --- Validate environment variables ---
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN in .env");
  process.exit(1);
}
if (!process.env.FIREBASE_KEY_JSON) {
  console.error("❌ Missing FIREBASE_KEY_JSON in environment variables");
  process.exit(1);
}
if (!process.env.CHANNEL_ID) {
  console.error("❌ Missing CHANNEL_ID in .env");
  process.exit(1);
}

// --- Init Firebase ---
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY_JSON)
  ),
});
const db = admin.firestore();

// --- Init Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const CHANNEL_ID = process.env.CHANNEL_ID;

// --- Watch Firestore ---
let unsubscribe = null;

async function watchRequests() {
  if (unsubscribe) unsubscribe();

  console.log("👀 Watching Firestore for new requests...");

  unsubscribe = db.collection("requests").onSnapshot(async (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== "added") return;

      const docId = change.doc.id;

      if (processed.has(docId)) return;
      processed.add(docId);

      const data = change.doc.data();
      const deviceId = data.deviceId;
      const username = data.username || "Unknown User";
      const deviceName = data.deviceName || "Unnamed Device";

      console.log(`📩 New request received: ${username} (${deviceName})`);

      const embed = new EmbedBuilder()
        .setTitle("🕷 New Device Registration Request")
        .setDescription(
          `**Username:** ${username}\n**Device Name:** ${deviceName}\n**Device ID:** \`${deviceId}\``
        )
        .setColor(0x3498db)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${deviceId}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`deny_${deviceId}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger)
      );

      try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        await channel.send({ embeds: [embed], components: [row] });
      } catch (err) {
        console.error("❌ Failed to send message:", err);
      }
    });
  });
}

// --- Handle buttons ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, deviceId] = interaction.customId.split("_");

  const reqRef = db.collection("requests").doc(deviceId);
  const deviceRef = db.collection("devices").doc(deviceId);

  const snapshot = await reqRef.get();

  if (!snapshot.exists) {
    return interaction.reply({
      content: "⚠️ Already processed.",
      ephemeral: true,
    });
  }

  const data = snapshot.data();
  const username = data.username || "Unknown";
  const deviceName = data.deviceName || "Unnamed";

  let approved = action === "approve";

  try {
    await deviceRef.set({
      deviceId,
      username,
      deviceName,
      approved,
      timestamp: new Date().toISOString(),
    });

    await interaction.reply({
      content: approved
        ? `✅ Approved ${username}`
        : `❌ Denied ${username}`,
      ephemeral: true,
    });

    // 🔁 Update buttons
    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${deviceId}`)
        .setLabel(approved ? "✅ Approved" : "Approve")
        .setStyle(ButtonStyle.Success)
        .setDisabled(approved),

      new ButtonBuilder()
        .setCustomId(`deny_${deviceId}`)
        .setLabel(!approved ? "❌ Denied" : "Deny")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!approved)
    );

    await interaction.message.edit({
      components: [updatedRow],
    });

  } catch (err) {
    console.error("❌ Error:", err);

    await interaction.reply({
      content: "⚠️ Error occurred.",
      ephemeral: true,
    });
  }
});

// --- Bot Ready ---
client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await watchRequests();
});

// --- Keep alive server ---
app.get("/", (req, res) => {
  res.send("🤖 Bot is alive");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);