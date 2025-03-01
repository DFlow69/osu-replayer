const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const bodyParser = require('body-parser');
const cors = require('cors');
const osr = require('node-osr-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', req.body.conversionId || 'temp');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

// Set up temp directories
const tempDir = path.join(__dirname, 'temp');
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

[tempDir, uploadsDir, outputDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Queue system for conversions
const conversionQueue = [];
let isProcessing = false;

// OAuth2 client setup for Google Drive
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// API endpoint to start a conversion with online beatmap
app.post('/api/convert/online', upload.single('replayFile'), async (req, res) => {
  try {
    const { beatmapId, videoQuality, showStoryboard, showCursor, saveToDrive } = req.body;
    const replayFile = req.file;
    
    if (!replayFile || !beatmapId) {
      return res.status(400).json({ error: 'Missing required files or information' });
    }

    const conversionId = uuidv4();
    const jobDetails = {
      id: conversionId,
      beatmapId,
      replayPath: replayFile.path,
      mode: 'online',
      options: {
        videoQuality,
        showStoryboard: showStoryboard === 'yes',
        showCursor: showCursor === 'yes',
        saveToDrive: saveToDrive === 'yes'
      },
      progress: 0,
      status: 'queued',
      created: new Date()
    };

    // Add to queue and start processing if not already
    conversionQueue.push(jobDetails);
    res.json({ conversionId, status: 'queued' });
    
    if (!isProcessing) {
      processNextInQueue();
    }
  } catch (error) {
    console.error('Error starting online conversion:', error);
    res.status(500).json({ error: 'Failed to start conversion' });
  }
});

// API endpoint to start a conversion with uploaded beatmap
app.post('/api/convert/upload', upload.fields([
  { name: 'replayFile', maxCount: 1 },
  { name: 'beatmapFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const { videoQuality, showStoryboard, showCursor, saveToDrive } = req.body;
    const replayFile = req.files.replayFile[0];
    const beatmapFile = req.files.beatmapFile[0];
    
    if (!replayFile || !beatmapFile) {
      return res.status(400).json({ error: 'Missing required files' });
    }

    const conversionId = uuidv4();
    const jobDetails = {
      id: conversionId,
      beatmapPath: beatmapFile.path,
      replayPath: replayFile.path,
      mode: 'upload',
      options: {
        videoQuality,
        showStoryboard: showStoryboard === 'yes',
        showCursor: showCursor === 'yes',
        saveToDrive: saveToDrive === 'yes'
      },
      progress: 0,
      status: 'queued',
      created: new Date()
    };

    // Add to queue and start processing if not already
    conversionQueue.push(jobDetails);
    res.json({ conversionId, status: 'queued' });
    
    if (!isProcessing) {
      processNextInQueue();
    }
  } catch (error) {
    console.error('Error starting upload conversion:', error);
    res.status(500).json({ error: 'Failed to start conversion' });
  }
});

// API endpoint to check conversion status
app.get('/api/status/:conversionId', (req, res) => {
  const { conversionId } = req.params;
  const job = conversionQueue.find(job => job.id === conversionId);
  
  if (!job) {
    // Check if the job is completed and has output files
    const outputFile = path.join(outputDir, `${conversionId}.mp4`);
    if (fs.existsSync(outputFile)) {
      const stats = fs.statSync(outputFile);
      return res.json({
        status: 'completed',
        progress: 100,
        result: {
          fileSize: formatFileSize(stats.size),
          videoPath: `/api/download/${conversionId}`,
          thumbnailPath: `/api/thumbnail/${conversionId}`
        }
      });
    }
    return res.status(404).json({ error: 'Conversion job not found' });
  }
  
  res.json({
    status: job.status,
    progress: job.progress,
    message: job.statusMessage,
    result: job.result
  });
});

// API endpoint to download converted video
app.get('/api/download/:conversionId', (req, res) => {
  const { conversionId } = req.params;
  const videoPath = path.join(outputDir, `${conversionId}.mp4`);
  
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video not found' });
  }
  
  res.download(videoPath);
});

// API endpoint to get video thumbnail
app.get('/api/thumbnail/:conversionId', (req, res) => {
  const { conversionId } = req.params;
  const thumbnailPath = path.join(outputDir, `${conversionId}.jpg`);
  
  if (!fs.existsSync(thumbnailPath)) {
    return res.status(404).json({ error: 'Thumbnail not found' });
  }
  
  res.sendFile(thumbnailPath);
});

// API endpoint for Google OAuth token exchange
app.post('/api/auth/google', async (req, res) => {
  const { code } = req.body;
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.json({ tokens });
  } catch (error) {
    console.error('Error exchanging code for tokens:', error);
    res.status(500).json({ error: 'Failed to authenticate with Google' });
  }
});

// API endpoint to upload to Google Drive
app.post('/api/upload/drive', async (req, res) => {
  const { conversionId, accessToken } = req.body;
  
  if (!conversionId || !accessToken) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  oauth2Client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  
  try {
    const videoPath = path.join(outputDir, `${conversionId}.mp4`);
    
    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const fileMetadata = {
      name: `osu_replay_${conversionId}.mp4`,
      mimeType: 'video/mp4'
    };
    
    const media = {
      mimeType: 'video/mp4',
      body: fs.createReadStream(videoPath)
    };
    
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id,webViewLink'
    });
    
    res.json({
      fileId: response.data.id,
      webViewLink: response.data.webViewLink
    });
  } catch (error) {
    console.error('Error uploading to Google Drive:', error);
    res.status(500).json({ error: 'Failed to upload to Google Drive' });
  }
});

// API endpoint to get queue status
app.get('/api/queue/status', (req, res) => {
  const queueLength = conversionQueue.filter(job => job.status === 'queued').length;
  const processing = conversionQueue.filter(job => job.status === 'processing').length;
  
  res.json({
    queueLength,
    processing,
    isProcessing
  });
});

// Process the next job in the queue
async function processNextInQueue() {
  if (conversionQueue.length === 0 || isProcessing) {
    return;
  }
  
  isProcessing = true;
  
  // Find the next queued job
  const nextJob = conversionQueue.find(job => job.status === 'queued');
  
  if (!nextJob) {
    isProcessing = false;
    return;
  }
  
  nextJob.status = 'processing';
  nextJob.statusMessage = 'Starting conversion process...';
  
  try {
    if (nextJob.mode === 'online') {
      await processOnlineMode(nextJob);
    } else {
      await processUploadMode(nextJob);
    }
  } catch (error) {
    console.error(`Error processing job ${nextJob.id}:`, error);
    nextJob.status = 'failed';
    nextJob.statusMessage = 'Conversion failed: ' + error.message;
  } finally {
    isProcessing = false;
    // Clean up the job from the queue after some time
    setTimeout(() => {
      const index = conversionQueue.findIndex(job => job.id === nextJob.id);
      if (index !== -1) {
        conversionQueue.splice(index, 1);
      }
    }, 3600000); // Remove after 1 hour
    
    // Process the next job
    processNextInQueue();
  }
}

// Process an online beatmap conversion
async function processOnlineMode(job) {
  try {
    // Update status
    job.progress = 10;
    job.statusMessage = 'Downloading beatmap...';
    
    // Download beatmap from osu! API
    const beatmapDir = path.join(tempDir, job.id);
    fs.mkdirSync(beatmapDir, { recursive: true });
    
    // In a real implementation, use official osu! API
    // Here we're using a simplified version
    const beatmapData = await downloadBeatmap(job.beatmapId, beatmapDir);
    job.progress = 30;
    job.statusMessage = 'Analyzing replay data...';
    
    // Parse the replay file
    const replayData = await parseReplayFile(job.replayPath);
    job.progress = 50;
    job.statusMessage = 'Rendering gameplay...';
    
    // Render gameplay using beatmap and replay data
    const outputPath = await renderGameplay(beatmapData, replayData, job);
    job.progress = 90;
    job.statusMessage = 'Finalizing video...';
    
    // Generate video thumbnail
    await generateThumbnail(outputPath, path.join(outputDir, `${job.id}.jpg`));
    
    // Calculate video duration and details
    const videoDetails = await getVideoDetails(outputPath);
    
    // Update job status to completed
    job.status = 'completed';
    job.progress = 100;
    job.statusMessage = 'Conversion completed';
    job.result = {
      fileSize: videoDetails.fileSize,
      duration: videoDetails.duration,
      resolution: videoDetails.resolution,
      videoPath: `/api/download/${job.id}`,
      thumbnailPath: `/api/thumbnail/${job.id}`
    };
    
    // Clean up temporary files
    cleanupTempFiles(beatmapDir);
    
  } catch (error) {
    console.error(`Error in online mode processing for job ${job.id}:`, error);
    job.status = 'failed';
    job.statusMessage = 'Conversion failed: ' + error.message;
    throw error;
  }
}

// Process an uploaded beatmap conversion
async function processUploadMode(job) {
  try {
    // Update status
    job.progress = 10;
    job.statusMessage = 'Processing beatmap file...';
    
    // Extract beatmap from uploaded file
    const beatmapDir = path.join(tempDir, job.id);
    fs.mkdirSync(beatmapDir, { recursive: true });
    
    await extractBeatmapArchive(job.beatmapPath, beatmapDir);
    job.progress = 30;
    job.statusMessage = 'Analyzing replay data...';
    
    // Parse the replay file
    const replayData = await parseReplayFile(job.replayPath);
    job.progress = 50;
    job.statusMessage = 'Rendering gameplay...';
    
    // Find the correct .osu file that matches the replay
    const beatmapFiles = fs.readdirSync(beatmapDir).filter(file => file.endsWith('.osu'));
    let beatmapFile = beatmapFiles[0]; // Default to first file if no match found
    
    // In a real implementation, match the beatmap file with the replay
    // Here we just use the first .osu file found
    
    const beatmapPath = path.join(beatmapDir, beatmapFile);
    const beatmapData = {
      path: beatmapPath,
      directory: beatmapDir
    };
    
    // Render gameplay using beatmap and replay data
    const outputPath = await renderGameplay(beatmapData, replayData, job);
    job.progress = 90;
    job.statusMessage = 'Finalizing video...';
    
    // Generate video thumbnail
    await generateThumbnail(outputPath, path.join(outputDir, `${job.id}.jpg`));
    
    // Calculate video duration and details
    const videoDetails = await getVideoDetails(outputPath);
    
    // Update job status to completed
    job.status = 'completed';
    job.progress = 100;
    job.statusMessage = 'Conversion completed';
    job.result = {
      fileSize: videoDetails.fileSize,
      duration: videoDetails.duration,
      resolution: videoDetails.resolution,
      videoPath: `/api/download/${job.id}`,
      thumbnailPath: `/api/thumbnail/${job.id}`
    };
    
    // Clean up temporary files
    cleanupTempFiles(beatmapDir);
    
  } catch (error) {
    console.error(`Error in upload mode processing for job ${job.id}:`, error);
    job.status = 'failed';
    job.statusMessage = 'Conversion failed: ' + error.message;
    throw error;
  }
}

// Download beatmap from osu! API (simplified)
async function downloadBeatmap(beatmapId, targetDir) {
  // Extract the beatmap ID from URL if provided
  if (beatmapId.includes('osu.ppy.sh')) {
    const matches = beatmapId.match(/\/(\d+)$/);
    if (matches && matches[1]) {
      beatmapId = matches[1];
    } else {
      // Try to extract from beatmapsets URL
      const setMatches = beatmapId.match(/beatmapsets\/(\d+)#osu\/(\d+)/);
      if (setMatches && setMatches[2]) {
        beatmapId = setMatches[2];
      }
    }
  }
  
  // In a real implementation, use the osu! API to download the beatmap
  // For this example, we'll simulate downloading (you would replace this with actual API calls)
  
  // Simulating API request delay
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // For a real implementation, you would:
  // 1. Get beatmap information from API
  // 2. Download the .osz file
  // 3. Extract it to the target directory
  
  // Return beatmap data object
  return {
    id: beatmapId,
    path: path.join(targetDir, 'beatmap.osu'), // This would be a real path in actual implementation
    directory: targetDir
  };
}

// Parse .osr replay file
async function parseReplayFile(replayPath) {
  // Parse replay data from .osr file
  // In a real implementation, use a library to parse the file format
  // For this example, we'll simulate parsing
  
  try {
    // Using a hypothetical osr parser library
    const replay = await osr.parseFile(replayPath);
    
    // In reality, you'd extract all the replay data:
    // - Player movements/inputs
    // - Timing data
    // - Score info
    // - etc.
    
    return {
      playerName: replay.playerName || 'Player',
      beatmapHash: replay.beatmapHash || '',
      score: replay.score || 0,
      combo: replay.maxCombo || 0,
      replayData: replay.replayData || [],
      mods: replay.mods || []
    };
  } catch (error) {
    console.error('Error parsing replay file:', error);
    throw new Error('Failed to parse replay file');
  }
}

// Extract beatmap archive
async function extractBeatmapArchive(archivePath, targetDir) {
  try {
    // Check file extension
    if (path.extname(archivePath).toLowerCase() === '.osz' || 
        path.extname(archivePath).toLowerCase() === '.zip') {
      
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(targetDir, true);
      
      return true;
    } else {
      throw new Error('Invalid beatmap file format');
    }
  } catch (error) {
    console.error('Error extracting beatmap archive:', error);
    throw new Error('Failed to extract beatmap file');
  }
}

// Render gameplay using FFmpeg
async function renderGameplay(beatmapData, replayData, job) {
  const outputPath = path.join(outputDir, `${job.id}.mp4`);
  
  // In a real implementation, you would:
  // 1. Render the gameplay visually using a library or engine
  // 2. Use FFmpeg to encode it into a video
  
  // For this simplified example, we'll just simulate the FFmpeg encoding process
  // with a sleep timer to simulate processing time
  
  let resolution;
  switch (job.options.videoQuality) {
    case '480p':
      resolution = '854x480';
      break;
    case '1080p':
      resolution = '1920x1080';
      break;
    default:
      resolution = '1280x720'; // 720p default
  }
  
  // In a real implementation, this would be the actual FFmpeg command
  // that renders the gameplay and creates the video file
  
  // Simulating processing time
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    job.progress += 5;
  }
  
  // Here you would run FFmpeg to generate the actual video
  // This is a placeholder for the actual implementation
  const ffmpegCommand = `-i input.raw -c:v libx264 -preset medium -crf 22 -c:a aac -b:a 128k -vf scale=${resolution} ${outputPath}`;
  
  // Create a dummy output file for demonstration
  // In a real implementation, this would be created by FFmpeg
  fs.writeFileSync(outputPath, 'Placeholder for video content');
  
  return outputPath;
}

// Generate video thumbnail
async function generateThumbnail(videoPath, outputPath) {
  // In a real implementation, use FFmpeg to generate a thumbnail
  // For this example, we'll create a placeholder file
  
  // The actual FFmpeg command would look something like:
  // ffmpeg -i ${videoPath} -ss 00:00:10 -vframes 1 ${outputPath}
  
  // Create a placeholder thumbnail file
  fs.writeFileSync(outputPath, 'Placeholder for thumbnail image');
  
  return outputPath;
}

// Get video details
async function getVideoDetails(videoPath) {
  // In a real implementation, use FFprobe to get video details
  // For this example, we'll return placeholder data
  
  // Placeholder video details
  const videoDetails = {
    fileSize: formatFileSize(Math.floor(Math.random() * 50000000) + 10000000), // Random size between 10-60MB
    duration: `${Math.floor(Math.random() * 4) + 2}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`, // Random duration between 2-5 minutes
    resolution: '1280×720 (HD)' // Default resolution
  };
  
  return videoDetails;
}

// Clean up temporary files
function cleanupTempFiles(directory) {
  try {
    if (fs.existsSync(directory)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } catch (error) {
    console.error('Error cleaning up temporary files:', error);
  }
}

// Format file size
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// Cleanup old files (run every 24 hours)
setInterval(() => {
  try {
    const outputFiles = fs.readdirSync(outputDir);
    const now = new Date();
    
    outputFiles.forEach(file => {
      const filePath = path.join(outputDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtime;
      
      // Remove files older than 24 hours
      if (fileAge > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (error) {
    console.error('Error cleaning up old files:', error);
  }
}, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`osu! Replay to Video Converter server running on port ${PORT}`);
});