class MediaClient {
    constructor(options = {}) {
        // Allow room name to be passed in through options
        this.roomName = options.roomName;
        if (!this.roomName) {
            this.roomName = prompt('Enter a room name to join:');
        }
        
        if (!this.roomName) {
            throw new Error('Room name is required.');
        }

        // Initialize WebSocket connection
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const host = window.location.hostname;
        this.ws = new WebSocket(`${protocol}://${host}:8080?room=${encodeURIComponent(this.roomName)}`);
        
        // Initialize class properties
        this.peers = new Map();
        this.localStream = null;
        this.userId = null;
        this.connectedUsers = new Set();

        // Set up WebSocket and UI event listeners
        this.initializeWebSocket();
        this.setupEventListeners();
    }

    initializeWebSocket() {
        this.ws.onmessage = async (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
                console.log('WebSocket message received:', data);
                
                if (data.error) {
                    console.error('Server error:', data.error);
                    alert(data.error);
                    return;
                }
            } catch (error) {
                console.error('Error parsing WebSocket message:', error, event.data);
                return;
            }
    
            switch (data.type) {
                case 'welcome':
                    console.log('Welcome message received:', data);
                    this.userId = data.userId;
                    break;
    
                case 'users':
                    console.log('User list received:', data.users);
                    await this.handleUserList(data.users);
                    break;
    
                case 'offer':
                    console.log('Received offer from:', data.from);
                    await this.handleOffer(data);
                    break;
    
                case 'answer':
                    console.log('Received answer from:', data.from);
                    await this.handleAnswer(data);
                    break;
    
                case 'ice-candidate':
                    console.log('Received ICE candidate from:', data.from);
                    await this.handleIceCandidate(data);
                    break;
    
                default:
                    console.warn('Unknown message type:', data.type);
            }
        };
    
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            alert('WebSocket connection error. Please try again.');
        };
    
        this.ws.onclose = () => {
            console.log('WebSocket connection closed.');
            this.cleanupConnections();
            alert('Connection to server lost. Please refresh to reconnect.');
        };

        this.ws.onopen = () => {
            console.log(`Connected to room: ${this.roomName}`);
        };
    }

    setupEventListeners() {
        const shareScreen = document.getElementById('shareScreen');
        const shareAudio = document.getElementById('shareAudio');
        const stopSharing = document.getElementById('stopSharing');

        if (shareScreen) shareScreen.onclick = () => this.shareScreen();
        if (shareAudio) shareAudio.onclick = () => this.shareAudio();
        if (stopSharing) stopSharing.onclick = () => this.stopLocalStream();
    }

    async shareScreen() {
        try {
            console.log('Initiating screen sharing...');
            this.stopLocalStream();

            this.localStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });

            console.log('Screen capture succeeded, setting up tracks...');
            this.localStream.getTracks().forEach(track => {
                track.onended = () => {
                    console.log('Screen sharing ended by user');
                    this.stopLocalStream();
                };
            });

            // Create peer connections for all connected users
            for (const userId of this.connectedUsers) {
                await this.createPeerConnection(userId);
            }
        } catch (error) {
            console.error('Error sharing screen:', error);
            alert('Failed to share screen: ' + error.message);
        }
    }

    async shareAudio() {
        try {
            console.log('Initiating audio sharing...');
            this.stopLocalStream();

            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: true
            });

            console.log('Audio capture succeeded, setting up tracks...');
            this.localStream.getTracks().forEach(track => {
                track.onended = () => {
                    console.log('Audio sharing ended');
                    this.stopLocalStream();
                };
            });

            // Create peer connections for all connected users
            for (const userId of this.connectedUsers) {
                await this.createPeerConnection(userId);
            }
        } catch (error) {
            console.error('Error sharing audio:', error);
            alert('Failed to share audio: ' + error.message);
        }
    }

    stopLocalStream() {
        if (this.localStream) {
            console.log('Stopping local stream and tracks...');
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        this.cleanupConnections();
    }

    cleanupConnections() {
        console.log('Cleaning up peer connections...');
        for (const [peerId, peer] of this.peers) {
            peer.close();
            this.removeVideoElement(peerId);
        }
        this.peers.clear();
    }

    async handleUserList(users) {
        console.log('Handling user list update:', users);
        const otherUsers = users.filter(id => id !== this.userId);
        console.log('Other users in room:', otherUsers);

        // Update connected users set
        this.connectedUsers = new Set(otherUsers);

        // Create peer connections for new users if we have a local stream
        if (this.localStream) {
            for (const userId of otherUsers) {
                if (!this.peers.has(userId)) {
                    await this.createPeerConnection(userId);
                }
            }
        }

        // Cleanup disconnected users
        for (const [peerId] of this.peers) {
            if (!otherUsers.includes(peerId)) {
                this.peers.get(peerId).close();
                this.removeVideoElement(peerId);
                this.peers.delete(peerId);
            }
        }
    }

    async createPeerConnection(userId) {
        if (!userId) {
            console.error('Attempted to create peer connection without userId');
            return;
        }

        console.log('Creating peer connection for user:', userId);
        const peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        this.peers.set(userId, peerConnection);

        // Add all local tracks to the peer connection
        this.localStream.getTracks().forEach(track => {
            console.log('Adding track to peer connection:', track.kind);
            peerConnection.addTrack(track, this.localStream);
        });

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate to:', userId);
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    target: userId,
                    candidate: event.candidate
                }));
            }
        };

        peerConnection.onconnectionstatechange = () => {
            console.log(`Peer ${userId} connection state changed to:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'disconnected' || 
                peerConnection.connectionState === 'failed') {
                this.removeVideoElement(userId);
                this.peers.delete(userId);
            }
        };

        peerConnection.ontrack = (event) => {
            console.log('Received track from peer:', event.track.kind);
            this.displayStream(event.streams[0], userId);
        };

        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            console.log('Created and set local offer for:', userId);

            this.ws.send(JSON.stringify({
                type: 'offer',
                target: userId,
                offer: offer
            }));
        } catch (error) {
            console.error('Error creating offer:', error);
            this.peers.delete(userId);
        }
    }

    async handleOffer(data) {
        if (!data.from) {
            console.error('Received offer without sender ID');
            return;
        }

        console.log('Handling offer from:', data.from);
        
        if (this.peers.has(data.from)) {
            console.log('Closing existing peer connection for:', data.from);
            this.peers.get(data.from).close();
            this.removeVideoElement(data.from);
            this.peers.delete(data.from);
        }

        const peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        this.peers.set(data.from, peerConnection);

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                console.log('Adding local track to peer connection:', track.kind);
                peerConnection.addTrack(track, this.localStream);
            });
        }

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Sending ICE candidate to:', data.from);
                this.ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    target: data.from,
                    candidate: event.candidate
                }));
            }
        };

        peerConnection.onconnectionstatechange = () => {
            console.log(`Peer ${data.from} connection state changed to:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'disconnected' || 
                peerConnection.connectionState === 'failed') {
                this.removeVideoElement(data.from);
                this.peers.delete(data.from);
            }
        };

        peerConnection.ontrack = (event) => {
            console.log('Received track from peer:', event.track.kind);
            this.displayStream(event.streams[0], data.from);
        };

        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            console.log('Created and set local answer for:', data.from);

            this.ws.send(JSON.stringify({
                type: 'answer',
                target: data.from,
                answer: answer
            }));
        } catch (error) {
            console.error('Error handling offer:', error);
            this.peers.delete(data.from);
            this.removeVideoElement(data.from);
        }
    }

    async handleAnswer(data) {
        if (!data.from) {
            console.error('Received answer without sender ID');
            return;
        }

        console.log('Handling answer from:', data.from);
        const peerConnection = this.peers.get(data.from);
        if (peerConnection) {
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log('Successfully set remote description for:', data.from);
            } catch (error) {
                console.error('Error setting remote description:', error);
                this.peers.delete(data.from);
                this.removeVideoElement(data.from);
            }
        } else {
            console.warn('Received answer for non-existent peer:', data.from);
        }
    }

    async handleIceCandidate(data) {
        if (!data.from) {
            console.error('Received ICE candidate without sender ID');
            return;
        }

        console.log('Handling ICE candidate from:', data.from);
        const peerConnection = this.peers.get(data.from);
        if (peerConnection) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                console.log('Successfully added ICE candidate for:', data.from);
            } catch (error) {
                console.error('Error adding ICE candidate:', error);
            }
        } else {
            console.warn('Received ICE candidate for non-existent peer:', data.from);
        }
    }

    removeVideoElement(userId) {
        console.log('Removing video element for:', userId);
        const videoWrapper = document.getElementById(`video-${userId}`);
        if (videoWrapper) {
            const video = videoWrapper.querySelector('video');
            if (video) {
                video.srcObject = null;
            }
            videoWrapper.remove();
        }
    }

    displayStream(stream, userId) {
        console.log('Displaying stream for:', userId);
        let videoWrapper = document.getElementById(`video-${userId}`);

        if (!videoWrapper) {
            videoWrapper = document.createElement('div');
            videoWrapper.id = `video-${userId}`;
            videoWrapper.className = 'video-wrapper';

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsInline = true;

            stream.onremovetrack = () => {
                console.log(`Stream from ${userId} ended`);
                this.removeVideoElement(userId);
            };

            videoWrapper.appendChild(video);
            document.getElementById('videoContainer').appendChild(videoWrapper);
        }

        const video = videoWrapper.querySelector('video');
        video.srcObject = stream;
    }
}
