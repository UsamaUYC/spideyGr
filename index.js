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

// 🧠 Track sent messages (prevents duplicates)
const sentMessages = new Map();

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
console.log("🔥 Firebase connected to project:", JSON.parse(process.env.FIREBASE_KEY_JSON).project_id);
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

  console.log("👀 Watching Firestore for requests...");

  unsubscribe = db.collection("requests").onSnapshot(async (snapshot) => {
    const channel = await client.channels.fetch(CHANNEL_ID);

    snapshot.docChanges().forEach(async (change) => {
      const doc = change.doc;
      const docId = doc.id;
      const data = doc.data();

      // ✅ ONLY handle new requests
      if (change.type !== "added") return;
      if (data.messageSent === true) return;

      const deviceId = data.deviceId;
      const username = data.username || "Unknown User";
      const deviceName = data.deviceName || "Unnamed Device";

      // 🔍 Check real status from devices collection
      const deviceSnap = await db.collection("devices").doc(deviceId).get();
      const deviceData = deviceSnap.exists ? deviceSnap.data() : null;

      const isApproved = deviceData?.approved === true;
      const isDenied = deviceData?.approved === false;

      // 🎨 Button styles
      const approveStyle = isApproved
        ? ButtonStyle.Success
        : ButtonStyle.Primary;

      const denyStyle = isDenied
        ? ButtonStyle.Danger
        : ButtonStyle.Primary;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${docId}`)
          .setLabel(isApproved ? "✅ Approved" : "Approve")
          .setStyle(approveStyle),

        new ButtonBuilder()
          .setCustomId(`deny_${docId}`)
          .setLabel(isDenied ? "❌ Denied" : "Deny")
          .setStyle(denyStyle)
      );

      const embed = new EmbedBuilder()
        .setTitle("🕷 Device Request")
        .setDescription(
          `**Username:** ${username}\n**Device:** ${deviceName}\n**ID:** \`${deviceId}\``
        )
        .setColor(
          isApproved ? 0x2ecc71 : isDenied ? 0xe74c3c : 0x3498db
        )
        .setTimestamp();

      try {
        const msg = await channel.send({
          embeds: [embed],
          components: [row],
        });

        // ✅ Mark as sent (PERSISTENT)
        await db.collection("requests").doc(docId).update({
          messageSent: true,
          messageId: msg.id,
        });

      } catch (err) {
        console.error("❌ Send error:", err);
      }
    });
  });
}

async function loadExistingRequests() {
  console.log("📦 Loading existing requests...");

  const channel = await client.channels.fetch(CHANNEL_ID);

  const snapshot = await db.collection("requests").get();

  console.log(`📊 Found ${snapshot.size} requests in Firestore`);

  for (const doc of snapshot.docs) {
    const data = doc.data();

    console.log("➡️ Processing doc:", doc.id, data);

    const docId = doc.id;
    const deviceId = data.deviceId;

    if (!deviceId) {
      console.log("⛔ Skipping (no deviceId)");
      continue;
    }

    const username = data.username || "Unknown User";
    const deviceName = data.deviceName || "Unnamed Device";

    try {
      const deviceSnap = await db.collection("devices").doc(deviceId).get();
      const deviceData = deviceSnap.exists ? deviceSnap.data() : null;

      const isApproved = deviceData?.approved === true;
      const isDenied = deviceData?.approved === false;

      console.log(`🧠 Status for ${deviceId}:`, deviceData);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${docId}`)
          .setLabel(isApproved ? "✅ Approved" : "Approve")
          .setStyle(isApproved ? ButtonStyle.Success : ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`deny_${docId}`)
          .setLabel(isDenied ? "❌ Denied" : "Deny")
          .setStyle(isDenied ? ButtonStyle.Danger : ButtonStyle.Primary)
      );

      const embed = new EmbedBuilder()
        .setTitle("🕷 Device Request")
        .setDescription(
          `**Username:** ${username}\n**Device:** ${deviceName}\n**ID:** \`${deviceId}\``
        )
        .setColor(
          isApproved ? 0x2ecc71 : isDenied ? 0xe74c3c : 0x3498db
        )
        .setTimestamp();

      const msg = await channel.send({
        embeds: [embed],
        components: [row],
      });

      console.log("✅ Sent message:", msg.id);

    } catch (err) {
      console.error("❌ Error sending message:", err);
    }
  }
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

  const deviceId = data.deviceId;
  const username = data.username || "Unknown";
  const deviceName = data.deviceName || "Unnamed";

  const deviceSnap = await db.collection("devices").doc(deviceId).get();
  const currentApproved = deviceSnap.exists
    ? deviceSnap.data().approved === true
    : false;
  const approved = action === "approve";

  // ❗ prevent same action spam
  if (approved === currentApproved) {
    return interaction.reply({
      content: `⚠️ Already ${approved ? "approved" : "denied"}.`,
      ephemeral: true,
    });
  }

  try {
    // ✅ Save to devices
    await db.collection("devices").doc(deviceId).set({
      deviceId,
      username,
      deviceName,
      approved,
      timestamp: new Date().toISOString(),
    });

    // ✅ Update request
    await reqRef.update({
      processed: true,
      approved: approved,
      updatedAt: new Date().toISOString(),
    });

    await interaction.reply({
      content: approved
        ? `✅ Approved ${username}`
        : `❌ Denied ${username}`,
      ephemeral: true,
    });

    // 🎨 Update buttons
    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${docId}`)
        .setLabel(approved ? "✅ Approved" : "Approve")
        .setStyle(
          approved ? ButtonStyle.Success : ButtonStyle.Primary
        ),

      new ButtonBuilder()
        .setCustomId(`deny_${docId}`)
        .setLabel(!approved ? "❌ Denied" : "Deny")
        .setStyle(
          !approved ? ButtonStyle.Danger : ButtonStyle.Primary
        )
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
client.on("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  try {
    console.log("🚀 Starting initial load...");
    await loadExistingRequests();

    console.log("👀 Starting live watcher...");
    await watchRequests();

  } catch (err) {
    console.error("❌ Startup error:", err);
  }
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