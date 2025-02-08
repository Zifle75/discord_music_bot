require('dotenv').config();

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
const youtubedl = require('youtube-dl-exec'); // Using youtube-dl-exec for downloading
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKEN = process.env.TOKEN;
const PREFIX = '!';

// Global map to hold queues per guild.
const guildQueues = new Map();

/**
 * Downloads the audio from a YouTube URL as an MP3 file using youtube-dl-exec.
 * @param {string} url - The YouTube video URL.
 * @returns {Promise<string>} - Resolves with the path to the temporary MP3 file.
 */
function downloadToMp3(url) {
  return new Promise((resolve, reject) => {
    // Create a unique temporary filename.
    const tempFilePath = path.join(os.tmpdir(), `track-${Date.now()}.mp3`);
    console.log(`Downloading audio to temporary file: ${tempFilePath}`);

    // Use youtube-dl-exec to extract audio and convert to MP3.
    youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFilePath,
      ffmpegLocation: process.env.FFMPEG_PATH, // Use our bundled ffmpeg.
      noCheckCertificates: true,
    })
      .then(output => {
        console.log("youtube-dl-exec output:", output);
        resolve(tempFilePath);
      })
      .catch(err => {
        reject(err);
      });
  });
}

/**
 * Plays the next track in the guild's queue.
 * @param {object} guildQueue - The guild queue object.
 */
function playNextTrack(guildQueue) {
  if (guildQueue.queue.length === 0) {
    console.log("Queue is empty, disconnecting.");
    guildQueue.connection.destroy();
    // Remove the guild's queue from the global map.
    guildQueues.delete(guildQueue.guildId);
    return;
  }
  const track = guildQueue.queue.shift();
  console.log(`Now playing next track: ${track.url}`);

  const stream = fs.createReadStream(track.tempFilePath);
  const resource = createAudioResource(stream, { inlineVolume: true });
  resource.volume.setVolume(1.0);
  guildQueue.player.play(resource);

  // When track finishes, delete its file and play the next track.
  guildQueue.player.once(AudioPlayerStatus.Idle, () => {
    console.log("Track finished, deleting temporary file.");
    fs.unlink(track.tempFilePath, (err) => {
      if (err) console.error("Error deleting temporary file:", err);
      else console.log("Temporary file deleted.");
    });
    playNextTrack(guildQueue);
  });
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

  // Command to list the current queue.
  if (command === 'list' || command === 'queue') {
    const guildId = message.guild.id;
    const guildQueue = guildQueues.get(guildId);
    if (!guildQueue || guildQueue.queue.length === 0) {
      return message.reply("The queue is empty.");
    }
    let reply = "Current Queue:\n";
    guildQueue.queue.forEach((track, index) => {
      reply += `${index + 1}. ${track.url}\n`;
    });
    return message.channel.send(reply);
  }

  // 'play' command.
  if (command === 'play') {
    // Ensure the user is in a voice channel.
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('You must be in a voice channel to play music!');
    }
    // Check for permissions.
    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
      return message.reply("I don't have permission to join and speak in your voice channel!");
    }

    // Extract flags.
    const loop = args.includes('-l'); // immediate play looping flag
    const queueFlag = args.includes('-q'); // add to queue flag
    // Remove flags from the arguments.
    const filteredArgs = args.filter(arg => arg !== '-l' && arg !== '-q');
    const url = filteredArgs[0];
    if (!url) {
      return message.reply("Please provide a YouTube URL.");
    }

    // If the -q flag is provided, add the track to the guild's queue.
    if (queueFlag) {
      const guildId = message.guild.id;
      let guildQueue = guildQueues.get(guildId);
      // If no queue exists for this guild, create one.
      if (!guildQueue) {
        // Join the voice channel.
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfMute: false,
          selfDeaf: false,
        });
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 30000);
          console.log("Voice connection is ready (queue mode).");
        } catch (error) {
          console.error("Failed to join voice channel:", error);
          return message.reply("Failed to join your voice channel in time.");
        }
        const player = createAudioPlayer();
        connection.subscribe(player);
        guildQueue = {
          guildId: message.guild.id,
          connection,
          player,
          queue: []
        };
        // When the player's idle event fires, it will be handled in playNextTrack.
        guildQueues.set(message.guild.id, guildQueue);
      }
      try {
        message.channel.send("Downloading track for the queue...");
        const tempFilePath = await downloadToMp3(url);
        const track = { url, tempFilePath };
        guildQueue.queue.push(track);
        message.channel.send(`Track added to queue at position ${guildQueue.queue.length}.`);
        // If nothing is playing, start playing the next track.
        if (guildQueue.player.state.status === AudioPlayerStatus.Idle) {
          playNextTrack(guildQueue);
        }
      } catch (error) {
        console.error("Error downloading track for queue:", error);
        message.reply("There was an error downloading the track.");
      }
      return; // Exit after queueing.
    }

    // Else, immediate play mode (non-queue).
    // Join the voice channel.
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfMute: false,
      selfDeaf: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
      console.log("Voice connection is ready (immediate play).");
    } catch (error) {
      console.error("Failed to join voice channel:", error);
      return message.reply("Failed to join your voice channel in time.");
    }
    const player = createAudioPlayer();
    connection.subscribe(player);

    let tempFilePath;
    // Function to play a local MP3 file (for immediate play).
    function playLocalFile(filePath) {
      const stream = fs.createReadStream(filePath);
      const resource = createAudioResource(stream, { inlineVolume: true });
      resource.volume.setVolume(1.0);
      player.play(resource);
      message.channel.send(`Now playing: ${url}`);
    }

    player.on(AudioPlayerStatus.Idle, () => {
      console.log("Audio player is idle (immediate play).");
      if (loop && tempFilePath) {
        console.log("Looping enabled; replaying track.");
        playLocalFile(tempFilePath);
      } else {
        connection.destroy();
        if (tempFilePath) {
          fs.unlink(tempFilePath, (err) => {
            if (err) console.error("Error deleting temporary file:", err);
            else console.log("Temporary file deleted.");
          });
        }
      }
    });

    player.on('error', (error) => {
      console.error("Audio player error:", error);
    });

    try {
      message.channel.send("Downloading track from YouTube as MP3...");
      tempFilePath = await downloadToMp3(url);
      console.log("Download complete. Temporary file:", tempFilePath);
      playLocalFile(tempFilePath);
    } catch (error) {
      console.error("Error downloading track:", error);
      message.reply("There was an error downloading the track.");
      connection.destroy();
    }
  }
});

client.login(TOKEN);
