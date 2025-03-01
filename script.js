// Google Drive API Configuration
const CLIENT_ID = '855119690404-34d4gmb1b8uta5t38pd8qhfcsr9nsrqv.apps.googleusercontent.com';
const API_KEY = 'AIzaSyB7y16_FbxV8Vp1V8FGsQvZ7XM3_Ktqc_s';
const DISCOVERY_DOCS = ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"];
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// API URL - change this to your actual backend URL
const API_URL = 'http://localhost:3000/api';

let isGoogleSignedIn = false;
let activeConversionIds = {
    online: null,
    upload: null
};
let pollingIntervals = {
    online: null,
    upload: null
};
let driveLinks = {
    online: null,
    upload: null
};

// Load the Google API client library
function initGoogleApi() {
    gapi.load('client:auth2', initClient);
}

// Initialize the Google API client
function initClient() {
    gapi.client.init({
        apiKey: API_KEY,
        clientId: CLIENT_ID,
        discoveryDocs: DISCOVERY_DOCS,
        scope: SCOPES
    }).then(function() {
        // Listen for sign-in state changes
        gapi.auth2.getAuthInstance().isSignedIn.listen(updateSigninStatus);
        
        // Handle the initial sign-in state
        updateSigninStatus(gapi.auth2.getAuthInstance().isSignedIn.get());
        
        // Add event listeners for authorization buttons
        document.getElementById('authorize-button').onclick = handleAuthClick;
        document.getElementById('signout-button').onclick = handleSignoutClick;
    }).catch(function(error) {
        console.error('Error initializing Google API client:', error);
        showError('online', 'Failed to initialize Google Drive API. Please try again later.');
    });
}

// Update UI based on sign-in status
function updateSigninStatus(isSignedIn) {
    isGoogleSignedIn = isSignedIn;
    
    if (isSignedIn) {
        document.getElementById('authorize-button').style.display = 'none';
        document.getElementById('logged-in-status').style.display = 'block';
        
        // Display user email
        const user = gapi.auth2.getAuthInstance().currentUser.get();
        const profile = user.getBasicProfile();
        document.getElementById('user-email').textContent = profile.getEmail();
        
        // Update server status
        updateServerStatus(true);
    } else {
        document.getElementById('authorize-button').style.display = 'inline-block';
        document.getElementById('logged-in-status').style.display = 'none';
        
        // Update server status
        updateServerStatus(false);
    }
}

// Handle sign-in button click
function handleAuthClick() {
    gapi.auth2.getAuthInstance().signIn();
}

// Handle sign-out button click
function handleSignoutClick() {
    gapi.auth2.getAuthInstance().signOut();
}

// Update server status display
function updateServerStatus(connected) {
    // Get queue status from server
    fetch(`${API_URL}/queue/status`)
        .then(response => response.json())
        .then(data => {
            const statusText = connected ? 
                `Server status: Online (${data.queueLength} jobs in queue) - Google Drive connected` : 
                `Server status: Online (${data.queueLength} jobs in queue)`;
            
            document.getElementById('server-status-text').textContent = statusText;
        })
        .catch(error => {
            console.error('Error fetching queue status:', error);
            const statusText = connected ? 
                'Server status: Online - Google Drive connected' : 
                'Server status: Online';
            
            document.getElementById('server-status-text').textContent = statusText;
        });
}

// Check if Google Drive save is enabled and user is signed in
function checkGoogleDriveRequirement(mode) {
    const saveToDrive = document.getElementById(`save-drive-${mode}`).value === 'yes';
    
    if (saveToDrive && !isGoogleSignedIn) {
        showError(mode, 'You need to sign in with Google to save to Google Drive. Please sign in and try again.');
        return false;
    }
    
    return true;
}

// Tab switching functionality
function switchTab(tabIndex) {
    const tabs = document.querySelectorAll('.tab-button');
    const contents = document.querySelectorAll('.converter-content');
    
    tabs.forEach((tab, index) => {
        if (index === tabIndex) {
            tab.classList.add('active');
            contents[index].classList.add('active');
        } else {
            tab.classList.remove('active');
            contents[index].classList.remove('active');
        }
    });
}

// File input handling
document.getElementById('replay-file-online').addEventListener('change', function(e) {
    updateFileName('replay-file-online', 'replay-name-online');
});

document.getElementById('replay-file-upload').addEventListener('change', function(e) {
    updateFileName('replay-file-upload', 'replay-name-upload');
});

document.getElementById('beatmap-file').addEventListener('change', function(e) {
    updateFileName('beatmap-file', 'beatmap-name');
});

function updateFileName(inputId, nameId) {
    const input = document.getElementById(inputId);
    const nameDisplay = document.getElementById(nameId);
    
    if (input.files.length > 0) {
        nameDisplay.textContent = input.files[0].name;
    } else {
        nameDisplay.textContent = 'No file chosen';
    }
}

// Start conversion (online beatmap mode)
function startConversionOnline() {
    const beatmapId = document.getElementById('beatmap-id').value;
    const replayFileInput = document.getElementById('replay-file-online');
    const quality = document.getElementById('video-quality-online').value;
    const storyboard = document.getElementById('storyboard-online').value;
    const cursor = document.getElementById('cursor-online').value;
    const saveToDrive = document.getElementById('save-drive-online').value;
    
    if (!beatmapId) {
        showError('online', 'Please enter a beatmap ID or URL');
        return;
    }
    
    if (!replayFileInput.files || replayFileInput.files.length === 0) {
        showError('online', 'Please select a replay file');
        return;
    }
    
    // Check Google Drive requirements
    if (!checkGoogleDriveRequirement('online')) {
        return;
    }
    
    // Hide error if previously shown
    document.getElementById('error-message-online').style.display = 'none';
    
    // Disable the convert button during processing
    document.getElementById('convert-online-btn').disabled = true;
    
    // Show progress
    const progressContainer = document.getElementById('progress-container-online');
    const progressStatus = document.getElementById('progress-status-online');
    progressContainer.style.display = 'block';
    progressStatus.textContent = 'Preparing files...';
    
    // Create FormData for file upload
    const formData = new FormData();
    formData.append('replayFile', replayFileInput.files[0]);
    formData.append('beatmapId', beatmapId);
    formData.append('videoQuality', quality);
    formData.append('showStoryboard', storyboard);
    formData.append('showCursor', cursor);
    formData.append('saveToDrive', saveToDrive);
    
    // Send the conversion request to the server
    fetch(`${API_URL}/convert/online`, {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            showError('online', data.error);
            document.getElementById('convert-online-btn').disabled = false;
            progressContainer.style.display = 'none';
            return;
        }
        
        // Store the conversion ID
        activeConversionIds.online = data.conversionId;
        
        // Start polling for status updates
        startPolling('online');
    })
    .catch(error => {
        console.error('Error starting conversion:', error);
        showError('online', 'Failed to start conversion. Please try again later.');
        document.getElementById('convert-online-btn').disabled = false;
        progressContainer.style.display = 'none';
    });
}

// Start conversion (upload beatmap mode)
function startConversionUpload() {
    const replayFileInput = document.getElementById('replay-file-upload');
    const beatmapFileInput = document.getElementById('beatmap-file');
    const quality = document.getElementById('video-quality-upload').value;
    const storyboard = document.getElementById('storyboard-upload').value;
    const cursor = document.getElementById('cursor-upload').value;
    const saveToDrive = document.getElementById('save-drive-upload').value;
    
    if (!replayFileInput.files || replayFileInput.files.length === 0) {
        showError('upload', 'Please select a replay file');
        return;
    }
    
    if (!beatmapFileInput.files || beatmapFileInput.files.length === 0) {
        showError('upload', 'Please select a beatmap file');
        return;
    }
    
    // Check Google Drive requirements
    if (!checkGoogleDriveRequirement('upload')) {
        return;
    }
    
    // Hide error if previously shown
    document.getElementById('error-message-upload').style.display = 'none';
    
    // Disable the convert button during processing
    document.getElementById('convert-upload-btn').disabled = true;
    
    // Show progress
    const progressContainer = document.getElementById('progress-container-upload');
    const progressStatus = document.getElementById('progress-status-upload');
    progressContainer.style.display = 'block';
    progressStatus.textContent = 'Preparing files...';
    
    // Create FormData for file upload
    const formData = new FormData();
    formData.append('replayFile', replayFileInput.files[0]);
    formData.append('beatmapFile', beatmapFileInput.files[0]);
    formData.append('videoQuality', quality);
    formData.append('showStoryboard', storyboard);
    formData.append('showCursor', cursor);
    formData.append('saveToDrive', saveToDrive);
    
    // Send the conversion request to the server
    fetch(`${API_URL}/convert/upload`, {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            showError('upload', data.error);
            document.getElementById('convert-upload-btn').disabled = false;
            progressContainer.style.display = 'none';
            return;
        }
        
        // Store the conversion ID
        activeConversionIds.upload = data.conversionId;
        
        // Start polling for status updates
        startPolling('upload');
    })
    .catch(error => {
        console.error('Error starting conversion:', error);
        showError('upload', 'Failed to start conversion. Please try again later.');
        document.getElementById('convert-upload-btn').disabled = false;
        progressContainer.style.display = 'none';
    });
}

// Start polling for conversion status
function startPolling(mode) {
    const conversionId = activeConversionIds[mode];
    if (!conversionId) return;
    
    const progressBar = document.getElementById(`progress-bar-${mode}`);
    const progressStatus = document.getElementById(`progress-status-${mode}`);
    
    // Clear any existing interval
    if (pollingIntervals[mode]) {
        clearInterval(pollingIntervals[mode]);
    }
    
    // Set up new polling interval
    pollingIntervals[mode] = setInterval(() => {
        fetch(`${API_URL}/status/${conversionId}`)
            .then(response => response.json())
            .then(data => {
                if (data.error) {
                    clearInterval(pollingIntervals[mode]);
                    showError(mode, data.error);
                    document.getElementById(`convert-${mode}-btn`).disabled = false;
                    return;
                }
                
                // Update progress bar and status
                progressBar.style.width = `${data.progress}%`;
                progressStatus.textContent = data.message || `Processing (${data.progress}%)`;
                
                // Check if conversion is complete
                if (data.status === 'completed') {
                    clearInterval(pollingIntervals[mode]);
                    showResult(mode, data.result);
                    document.getElementById(`convert-${mode}-btn`).disabled = false;
                    
                    // Check if we need to upload to Google Drive
                    const saveToDrive = document.getElementById(`save-drive-${mode}`).value === 'yes';
                    if (saveToDrive && isGoogleSignedIn) {
                        uploadToDrive(mode, conversionId);
                    }
                }
                // Check if conversion failed
                else if (data.status === 'failed') {
                    clearInterval(pollingIntervals[mode]);
                    showError(mode, data.message || 'Conversion failed');
                    document.getElementById(`convert-${mode}-btn`).disabled = false;
                }
            })
            .catch(error => {
                console.error('Error polling conversion status:', error);
                // Don't stop polling on temporary errors, but update status message
                progressStatus.textContent = 'Checking status...';
            });
    }, 2000); // Poll every 2 seconds
}

// Show error message
function showError(mode, message) {
    const errorMessage = document.getElementById(`error-message-${mode}`);
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    
    // Hide progress container
    document.getElementById(`progress-container-${mode}`).style.display = 'none';
}

// Show conversion result
function showResult(mode, result) {
    const resultContainer = document.getElementById(`result-container-${mode}`);
    const progressContainer = document.getElementById(`progress-container-${mode}`);
    const videoPreview = document.getElementById(`video-preview-${mode}`);
    const downloadLink = document.getElementById(`download-link-${mode}`);
    const fileInfo = document.getElementById(`file-info-${mode}`);
    
    // Hide progress container and show result container
    progressContainer.style.display = 'none';
    resultContainer.style.display = 'block';
    
    // Set video preview thumbnail
    videoPreview.src = result.thumbnailPath;
    
    // Set download link
    downloadLink.href = result.videoPath;
    downloadLink.download = `osu_replay_${activeConversionIds[mode]}.mp4`;
    
    // Set file info
    fileInfo.textContent = `Size: ${result.fileSize}, Duration: ${result.duration || 'Unknown'}`;
}

// Upload video to Google Drive
function uploadToDrive(mode, conversionId) {
    const progressStatus = document.getElementById(`progress-status-${mode}`);
    progressStatus.textContent = 'Uploading to Google Drive...';
    
    // Get the user's access token
    const accessToken = gapi.auth2.getAuthInstance().currentUser.get().getAuthResponse().access_token;
    
    // Send upload request to server
    fetch(`${API_URL}/upload/drive`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            conversionId,
            accessToken
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            console.error('Error uploading to Drive:', data.error);
            progressStatus.textContent = 'Failed to upload to Google Drive';
            return;
        }
        
        // Store the Drive link
        driveLinks[mode] = data.webViewLink;
        
        // Update the UI to show the Drive link
        const driveLink = document.getElementById(`drive-link-${mode}`);
        driveLink.href = data.webViewLink;
        driveLink.textContent = 'View on Google Drive';
        driveLink.style.display = 'inline-block';
        
        progressStatus.textContent = 'Successfully uploaded to Google Drive';
    })
    .catch(error => {
        console.error('Error uploading to Google Drive:', error);
        progressStatus.textContent = 'Failed to upload to Google Drive';
    });
}

// Reset form and UI for a new conversion
function resetConversion(mode) {
    // Clear file inputs
    document.getElementById(`replay-file-${mode}`).value = '';
    document.getElementById(`replay-name-${mode}`).textContent = 'No file chosen';
    
    if (mode === 'upload') {
        document.getElementById('beatmap-file').value = '';
        document.getElementById('beatmap-name').textContent = 'No file chosen';
    } else {
        document.getElementById('beatmap-id').value = '';
    }
    
    // Hide result container
    document.getElementById(`result-container-${mode}`).style.display = 'none';
    
    // Hide error message
    document.getElementById(`error-message-${mode}`).style.display = 'none';
    
    // Reset progress bar
    document.getElementById(`progress-bar-${mode}`).style.width = '0%';
    
    // Clear active conversion ID
    activeConversionIds[mode] = null;
    
    // Clear polling interval
    if (pollingIntervals[mode]) {
        clearInterval(pollingIntervals[mode]);
        pollingIntervals[mode] = null;
    }
    
    // Clear Drive link
    driveLinks[mode] = null;
    const driveLink = document.getElementById(`drive-link-${mode}`);
    driveLink.href = '#';
    driveLink.textContent = '';
    driveLink.style.display = 'none';
}

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    // Attach event handlers to tabs
    document.querySelectorAll('.tab-button').forEach((tab, index) => {
        tab.addEventListener('click', () => switchTab(index));
    });
    
    // Attach event handlers to convert buttons
    document.getElementById('convert-online-btn').addEventListener('click', startConversionOnline);
    document.getElementById('convert-upload-btn').addEventListener('click', startConversionUpload);
    
    // Attach event handlers to reset buttons
    document.getElementById('reset-online-btn').addEventListener('click', () => resetConversion('online'));
    document.getElementById('reset-upload-btn').addEventListener('click', () => resetConversion('upload'));
    
    // Initialize server status
    updateServerStatus(false);
    
    // Load Google API if available
    if (typeof gapi !== 'undefined') {
        initGoogleApi();
    } else {
        console.warn('Google API not available. Google Drive functionality will be disabled.');
    }
});
