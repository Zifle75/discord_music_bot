require('dotenv').config();
const youtubedl = require('yt-dlp-exec');

// Ensure FFmpeg is available.
process.env.FFMPEG_PATH = require('ffmpeg-static');
console.log("FFmpeg path:", process.env.FFMPEG_PATH);

const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKEN = process.env.TOKEN;
const PREFIX = '!';

// Global map to hold queues per guild.
const guildQueues = new Map();

/**
 * Clean up leftover temp files that start with "track-" in the OS temp folder.
 * Matches any extension (mp3, part, webm, etc.) so partial/failed downloads
 * from a previous crashed session get purged too, not just clean .mp3 files.
 */
function cleanTempFolder() {
  const tmpDir = os.tmpdir();
  fs.readdir(tmpDir, (err, files) => {
    if (err) {
      return console.error("Error reading temp directory:", err);
    }
    files.forEach(file => {
      if (file.startsWith('track-')) {
        const filePath = path.join(tmpDir, file);
        fs.unlink(filePath, err => {
          if (err) console.error(`Error deleting temp file ${filePath}:`, err);
          else console.log(`Deleted temp file: ${filePath}`);
        });
      }
    });
  });
}

// Clean temp folder on startup.
cleanTempFolder();

/**
 * Downloads the audio from a YouTube URL as an MP3 file using yt-dlp-exec.
 * @param {string} url - The YouTube video URL.
 * @returns {Promise<string>} - Resolves with the path to the temporary MP3 file.
 */
function downloadToMp3(url) {
  return new Promise((resolve, reject) => {
    // Create a unique temporary filename.
    const tempFilePath = path.join(os.tmpdir(), `track-${Date.now()}.mp3`);
    console.log(`[DEBUG] Downloading audio to temporary file: ${tempFilePath}`);

    // Use yt-dlp-exec to extract audio and convert to MP3.
    youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFilePath,
      ffmpegLocation: process.env.FFMPEG_PATH, // Use our bundled ffmpeg.
      noCheckCertificates: true,
    })
      .then(output => {
        console.log("[DEBUG] yt-dlp-exec output:", output);
        resolve(tempFilePath);
      })
      .catch(err => {
        console.error("[DEBUG] yt-dlp-exec error:", err);
        reject(err);
      });
  });
}

/**
 * Plays a track and sets up the idle event handler.
 * If loop mode is enabled, the same track is replayed continuously until toggled off.
 * This idle handler now checks to ensure that the track finishing is still the current track.
 * @param {object} guildQueue - The guild queue object.
 * @param {object} track - The track object containing url and tempFilePath.
 */
function playTrack(guildQueue, track) {
  console.log(`[DEBUG] playTrack called for: ${track.url}`);
  const stream = fs.createReadStream(track.tempFilePath);
  stream.on('error', (err) => console.error("[DEBUG] Read stream error:", err));

  const resource = createAudioResource(stream, { inlineVolume: true });
  resource.volume.setVolume(1.0);

  guildQueue.player.play(resource);
  console.log(`[DEBUG] Player state after play(): ${guildQueue.player.state.status}`);

  guildQueue.player.once(AudioPlayerStatus.Idle, () => {
    console.log("[DEBUG] Player went idle.");
    // If a new track has replaced the current one, ignore this idle event.
    if (guildQueue.currentTrack !== track) {
      console.log("[DEBUG] Track replaced, ignoring idle event.");
      return;
    }
    if (guildQueue.loop) {
      console.log("[DEBUG] Looping enabled; replaying track.");
      playTrack(guildQueue, track);
    } else {
      console.log("[DEBUG] Track finished, deleting temporary file.");
      fs.unlink(track.tempFilePath, (err) => {
        if (err) console.error("[DEBUG] Error deleting temporary file:", err);
        else console.log("[DEBUG] Temporary file deleted.");
      });
      // Clear currentTrack and move on to the next track.
      guildQueue.currentTrack = null;
      playNextTrack(guildQueue);
    }
  });
}

/**
 * Asynchronously plays the next track in the guild's queue.
 * If the track was added lazily (without a downloaded file), it downloads it first.
 * @param {object} guildQueue - The guild queue object.
 */
async function playNextTrack(guildQueue) {
  console.log(`[DEBUG] playNextTrack called. Queue length: ${guildQueue.queue.length}`);
  // If no track is queued, disconnect.
  if (guildQueue.queue.length === 0) {
    console.log("[DEBUG] Queue is empty, disconnecting.");
    guildQueue.connection.destroy();
    guildQueues.delete(guildQueue.guildId);
    return;
  }

  // Get the next track.
  const track = guildQueue.queue.shift();
  // Lazy download: if tempFilePath is not already set, download now.
  if (!track.tempFilePath) {
    try {
      track.tempFilePath = await downloadToMp3(track.url);
    } catch (error) {
      console.error("[DEBUG] Error downloading lazy track:", error);
      // Skip to next track on error.
      return playNextTrack(guildQueue);
    }
  }
  guildQueue.currentTrack = track;
  console.log(`[DEBUG] Now playing next track: ${track.url}`);
  playTrack(guildQueue, track);
}

/**
 * Helper to get or create a guild queue.
 * If a queue does not exist, this function creates one and connects to the voice channel.
 * @param {object} message - The Discord message object.
 * @param {object} voiceChannel - The voice channel to connect to.
 * @returns {object} The guild queue object.
 */
async function getOrCreateGuildQueue(message, voiceChannel) {
  const guildId = message.guild.id;
  let guildQueue = guildQueues.get(guildId);
  if (!guildQueue) {
    console.log(`[DEBUG] Creating new voice connection for guild: ${guildId}, channel: ${voiceChannel.id}`);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfMute: false,
      selfDeaf: false,
      debug: true,
    });

    connection.on('debug', (msg) => console.log('[VOICE DEBUG]', msg));
    connection.on('error', (err) => console.error('[VOICE ERROR]', err));
    connection.on('stateChange', (oldState, newState) => {
      console.log(`[DEBUG] Voice state: ${oldState.status} -> ${newState.status}`);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
      console.log("[DEBUG] Voice connection is ready.");
    } catch (error) {
      console.error("[DEBUG] Failed to join voice channel:", error);
      console.error("[DEBUG] Connection state at failure:", connection.state);
      message.reply("Whamshanks feels antisocial right now.");
      return null;
    }
    const player = createAudioPlayer();
    player.on('error', (err) => console.error('[PLAYER ERROR]', err));
    player.on('stateChange', (oldState, newState) => {
      console.log(`[DEBUG] Player state: ${oldState.status} -> ${newState.status}`);
    });

    connection.subscribe(player);
    guildQueue = {
      guildId: message.guild.id,
      connection,
      player,
      queue: [],
      loop: false,
      currentTrack: null,
    };
    guildQueues.set(guildId, guildQueue);
  }
  return guildQueue;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Needed to read messages.
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  // Ignore messages from bots or those that don't start with the prefix.
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  // Split the command and arguments.
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // List the current queue.
  if (command === 'list' || command === 'queue') {
    const guildId = message.guild.id;
    const guildQueue = guildQueues.get(guildId);
    if (!guildQueue || (guildQueue.queue.length === 0 && !guildQueue.currentTrack)) {
      return message.reply("Whamshanks has no tunes (⁄ ⁄•⁄ω⁄•⁄ ⁄) ");
    }
    let reply = "Current Queue:\n";
    if (guildQueue.currentTrack) {
      reply += `Crankin' ma hog to: ${guildQueue.currentTrack.url}\n`;
    }
    guildQueue.queue.forEach((track, index) => {
      reply += `${index + 1}. ${track.url}\n`;
    });
    return message.channel.send(reply);
  }

  // The 'play' command – starts playing a track immediately.
  if (command === 'play') {
    // Ensure the user is in a voice channel.
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Whamshanks plays music for nobody');
    }
    const url = args[0];
    if (!url) {
      return message.reply("Only Youtube URL. No playlists. ( )っ✂╰⋃╯ ");
    }

    console.log(`[DEBUG] play command invoked with URL: ${url}`);
    const guildQueue = await getOrCreateGuildQueue(message, voiceChannel);
    if (!guildQueue) return; // error already replied

    // If something is already playing, stop it, clear loop and queue.
    if (guildQueue.currentTrack) {
      message.channel.send("Whamshanks hates this song too. Playing a new one");
      guildQueue.queue = [];
      guildQueue.loop = false;
      // Mark current track as replaced before stopping.
      guildQueue.currentTrack = null;
      guildQueue.player.stop();
    }

    message.channel.send("Whamshanks is now pirate. Stealing music from big corpo archives");
    try {
      // Immediately download and play.
      const tempFilePath = await downloadToMp3(url);
      const track = { url, tempFilePath };
      guildQueue.currentTrack = track;
      message.channel.send(`Now playing: ${url}`);
      playTrack(guildQueue, track);
    } catch (error) {
      console.error("[DEBUG] Error downloading track:", error);
      message.reply("The opps have shanked Whamshanks.");
      guildQueue.connection.destroy();
      guildQueues.delete(message.guild.id);
    }
    return;
  }

  // The 'push' command – adds a track to the end of the queue (using lazy download).
  if (command === 'push') {
    // Ensure the user is in a voice channel.
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Whamshanks takes orders from nobody, unless I know them');
    }
    const url = args[0];
    if (!url) {
      return message.reply("𝓴𝓲𝓼𝓼 𝓶𝒆 𝓹𝓵𝒆𝓪𝓼𝒆 (´ ❥ `)ヽ⌒★");
    }

    console.log(`[DEBUG] push command invoked with URL: ${url}`);
    const guildQueue = await getOrCreateGuildQueue(message, voiceChannel);
    if (!guildQueue) return;

    // Cancel loop mode so the queue can advance normally instead of repeating.
    if (guildQueue.loop) {
      guildQueue.loop = false;
      guildQueue.player.stop();
    }

    // Create a lazy track (without downloading immediately).
    const track = { url };
    // Always append to the end of the queue so tracks play in the order they were pushed.
    guildQueue.queue.push(track);
    if (guildQueue.currentTrack) {
      message.channel.send(`Whamshanks added this to the queue: ${url}`);
    } else {
      message.channel.send(`Whamshanks says... are you sure you wanna add this?: ${url}`);
      // If nothing is playing, start playing.
      playNextTrack(guildQueue);
    }
    return;
  }

  // The 'loop' command – toggles looping of the current track.
  if (command === 'loop') {
    const guildId = message.guild.id;
    const guildQueue = guildQueues.get(guildId);
    if (!guildQueue || !guildQueue.currentTrack) {
      return message.reply("Ain't no tunes rn frfr");
    }
    // Toggle loop mode.
    guildQueue.loop = !guildQueue.loop;
    message.channel.send(`Loop mode is now ${guildQueue.loop ? "whamshabled" : "diswhamshabled"}.`);
    return;
  }

  // The 'quit' command – stops playback, disconnects and clears the queue.
  if (command === 'quit') {
    const guildId = message.guild.id;
    const guildQueue = guildQueues.get(guildId);
    if (!guildQueue) {
      return message.reply("Whamshanks only quits when ahead");
    }
    guildQueue.player.stop();
    guildQueue.connection.destroy();
    guildQueues.delete(guildId);
    message.channel.send("Whamshanks goes to college now. ಠ‿↼");
    return;
  }
});

client.login(TOKEN);