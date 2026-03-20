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
const express = require("express");

const app = express();

// --- Validate environment variables ---
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN");
  process.exit(1);
}
if (!process.env.FIREBASE_KEY_JSON) {
  console.error("❌ Missing FIREBASE_KEY_JSON");
  process.exit(1);
}
if (!process.env.CHANNEL_ID) {
  console.error("❌ Missing CHANNEL_ID");
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
      const data = change.doc.data();

      // ✅ Skip already processed requests
      if (data.processed === true) return;

      const deviceId = data.deviceId;
      const username = data.username || "Unknown User";
      const deviceName = data.deviceName || "Unnamed Device";

      console.log(`📩 New request: ${username} (${deviceName})`);

      const embed = new EmbedBuilder()
        .setTitle("🕷 New Device Registration Request")
        .setDescription(
          `**Username:** ${username}\n**Device Name:** ${deviceName}\n**Device ID:** \`${deviceId}\``
        )
        .setColor(0x3498db)
        .setTimestamp();

      // ✅ Button state (for safety if field exists)
      const isApproved = data.approved === true;
      const isProcessed = data.processed === true;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${docId}`)
          .setLabel(isApproved ? "✅ Approved" : "Approve")
          .setStyle(ButtonStyle.Success)
          .setDisabled(isApproved),

        new ButtonBuilder()
          .setCustomId(`deny_${docId}`)
          .setLabel(isProcessed && !isApproved ? "❌ Denied" : "Deny")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isProcessed && !isApproved)
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

  const [action, docId] = interaction.customId.split("_");

  const reqRef = db.collection("requests").doc(docId);
  const snapshot = await reqRef.get();

  if (!snapshot.exists) {
    return interaction.reply({
      content: "⚠️ Request not found.",
      ephemeral: true,
    });
  }

  const data = snapshot.data();

  // ✅ Prevent re-processing
  if (data.processed === true) {
    return interaction.reply({
      content: "⚠️ Already processed.",
      ephemeral: true,
    });
  }

  const deviceId = data.deviceId;
  const username = data.username || "Unknown";
  const deviceName = data.deviceName || "Unnamed";

  const approved = action === "approve";

  try {
    // ✅ Save decision
    await db.collection("devices").doc(deviceId).set({
      deviceId,
      username,
      deviceName,
      approved,
      timestamp: new Date().toISOString(),
    });

    // ✅ Mark request as processed
    await reqRef.update({
      processed: true,
      approved: approved,
    });

    await interaction.reply({
      content: approved
        ? `✅ Approved ${username}`
        : `❌ Denied ${username}`,
      ephemeral: true,
    });

    // ✅ Update buttons visually
    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${docId}`)
        .setLabel(approved ? "✅ Approved" : "Approve")
        .setStyle(ButtonStyle.Success)
        .setDisabled(approved),

      new ButtonBuilder()
        .setCustomId(`deny_${docId}`)
        .setLabel(!approved ? "❌ Denied" : "Deny")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!approved)
    );

    await interaction.message.edit({
      components: [updatedRow],
    });

    console.log(
      `${approved ? "✅ Approved" : "❌ Denied"} ${username} (${deviceId})`
    );

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