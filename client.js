// get DOM elements
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const dataChannelLog = document.getElementById("dataChannelLog");
const iceConnectionLog = document.getElementById("iceConnectionLog");
const iceGatheringLog = document.getElementById("iceGatheringLog");
const signalingLog = document.getElementById("signalingLog");
const pingLog = document.getElementById("pingRtt");

const useIssueWorkaroundCheckbox = document.getElementById("useIssueWorkaround");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const renegotiateBtn = document.getElementById("renegotiateBtn");
const requestRenegotiationBtn = document.getElementById("requestRenegotiationBtn");

// Config
const domain = "http://127.0.0.1:8080";
const useStun = false;

// global variables 
const pingInterval = 1000; // interval for dc ping in ms
var dcInterval = null;

var useRemappingIssueWorkaround = true;

var localStream = null;
var pc = null;
var dc = null;


// button / checkbox handlers
startBtn.onclick = start;
stopBtn.onclick = stop;
renegotiateBtn.onclick = renegotiate;
requestRenegotiationBtn.onclick = requestRenegotiation;
useIssueWorkaroundCheckbox.onchange = function (evt) {
    useRemappingIssueWorkaround = evt.target.checked;
}

/**
 * Loads the local stream and opens the connection to the backend.
 */
async function start() {
    createPeerConnection();
    await loadLocalStream();

    // Setup datachannel
    dc = pc.createDataChannel("chat");
    dc.onclose = function () {
        clearInterval(dcInterval);
        dataChannelLog.textContent += "- close\n";
        pingLog.textContent = "disconnected";
    };
    dc.onopen = function () {
        dataChannelLog.textContent += "- open\n";
        dcInterval = setInterval(function () {
            var message = "ping " + new Date().getTime();
            dataChannelLog.textContent += "> ping\n";
            dc.send(message);
        }, pingInterval);
    };
    dc.onmessage = handleDataChannelMessage;

    // Add local stream to peer connection
    localStream.getTracks().forEach(function (track) {
        pc.addTrack(track, localStream);
    });

    await negotiate();

    // Enable / disable buttons
    stopBtn.disabled = false;
    renegotiateBtn.disabled = false;
    requestRenegotiationBtn.disabled = false;
    startBtn.disabled = true;
    useIssueWorkaroundCheckbox.disabled = true;
}


/** Stop everything */
function stop() {
    localStream?.getTracks().forEach(track => track.stop());

    if (!pc || pc.connectionState == "closed") return;

    // close transceivers
    if (pc.getTransceivers) {
        pc.getTransceivers().forEach(function (transceiver) {
            if (transceiver.stop) {
                transceiver.stop();
            }
        });
    }

    // close local video
    pc.getSenders().forEach(function (sender) {
        if (sender && sender.track) {
            sender.track.stop();
        };
    });

    // close peer connection
    setTimeout(() => {
        if (pc) {
            pc.close();
        }
    }, 500);

    // Enable / disable buttons
    stopBtn.disabled = true;
    renegotiateBtn.disabled = true;
    requestRenegotiationBtn.disabled = true;
}


/**
 * Initiates the peer connection to the backend.
 */
function createPeerConnection() {
    var config;
    if (useStun) {
        config = {
            sdpSemantics: "unified-plan",
            iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
        };
    } else {
        config = {
            sdpSemantics: "unified-plan"
        };
    }

    pc = new RTCPeerConnection(config);

    // register some listeners to help debugging
    pc.addEventListener("icegatheringstatechange", function () {
        iceGatheringLog.textContent += " -> " + pc.iceGatheringState;
    }, false);
    iceGatheringLog.textContent = pc.iceGatheringState;

    pc.addEventListener("iceconnectionstatechange", function () {
        iceConnectionLog.textContent += " -> " + pc.iceConnectionState;
    }, false);
    iceConnectionLog.textContent = pc.iceConnectionState;

    pc.addEventListener("signalingstatechange", function () {
        signalingLog.textContent += " -> " + pc.signalingState;
    }, false);
    signalingLog.textContent = pc.signalingState;

    // connect audio / video
    pc.addEventListener("track", function (evt) {
        if (evt.track.kind == "video") {
            remoteVideo.srcObject = evt.streams[0];
        } else {
            console.error("NOT IMPLEMENTED");
        }
    });

    pc.addEventListener("ended", function (evt) {
        console.error("Track ended", evt);
    });
}


/**
 * Modifies sdp extmap mappings to avoid an error with aiortc, which seems to remap on
 * renegotiation unless we use a specific mapping used by aiortc. 
 * 
 * Workaround might cause other problems in case new mappings are not supported by this
 * client.
 * 
 * See https://github.com/aiortc/aiortc/issues/686
 */
function modifyOfferMappings(offer) {
    let i = 0;
    const newLines = [
        "a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid",
        "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time"
    ]

    // remove old and insert new mappings
    offer.sdp = offer.sdp?.split("\n")
        .map(line => line.startsWith("a=extmap:") ? undefined : line)
        .map(line => {
            if (line === undefined && i < 2) {
                line = newLines[i];
                i++;
            }
            return line;
        }).filter(line => line !== undefined).join("\n");

    return offer;
}


/**
 * Initial negotiation.
 * 
 * For renegotiating, please use renegotiate().
 */
async function negotiate() {
    console.log("negotiate");

    if (!pc) {
        console.error("Peer Connection not defined in negotiate");
        return;
    }

    let offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });

    if (useRemappingIssueWorkaround) {
        // remove all extmap mappings and apply the ones aiortc uses.
        offer = modifyOfferMappings(offer);
    }

    await pc.setLocalDescription(offer);

    // wait for iceGatheringState to be "complete"
    await new Promise((resolve) => {
        if (pc?.iceGatheringState === "complete") {
            resolve(undefined);
        } else {
            const checkState = () => {
                if (pc && pc.iceGatheringState === "complete") {
                    pc.removeEventListener("icegatheringstatechange", checkState);
                    resolve(undefined);
                }
            }
            pc?.addEventListener("icegatheringstatechange", checkState);
        }
    })

    const localDesc = pc.localDescription;

    console.log("LocalDescription (initial offer)", localDesc);

    const response = await fetch(domain + "/offer", {
        body: JSON.stringify({
            sdp: localDesc.sdp,
            type: localDesc.type,
        }),
        headers: {
            "Content-Type": "application/json"
        },
        method: "POST",
        mode: "cors",
    });

    const answer = await response.json();
    console.log("answer", answer);

    await pc.setRemoteDescription(answer);
}


/**
 * Starts a renegotiation using the datachannel for signaling.
 * 
 * For initial negotiation, please use negotiate().
 */
async function renegotiate() {
    console.log("Client starts renegotiation");

    // Checks if renegotiate is called to early
    if (!pc) {
        console.error("Peer Connection not defined in renegotiate");
        return;
    }

    if (pc.iceGatheringState !== "complete") {
        console.error("iceGatheringState is not complete:", pc.iceGatheringState);
        return;
    }

    if (!dc) {
        console.error("Data Channel not defined in renegotiate");
        return;
    }

    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    const localDesc = pc.localDescription;
    console.log("Offer (localDescription)", localDesc);

    dataChannelLog.textContent += "> client-renegotiation-offer\n";
    dc.send("client-renegotiation-offer" + JSON.stringify({
        sdp: localDesc.sdp,
        type: localDesc.type,
    }));
}


/**
 * Requests the server to start a renegotiation by sending a 
 * "request-renegotiation" message.
 */
function requestRenegotiation() {
    console.log("Sending \"request-renegotiation\"");
    dataChannelLog.textContent += "> request-renegotiation\n";
    dc?.send("request-renegotiation");
}


/**
 * Handler for incoming datachannel messages.
 */
async function handleDataChannelMessage(evt) {
    const message = evt.data;
    if (message.substring(0, 4) === "pong") {
        const elapsed_ms = new Date().getTime() - parseInt(message.substring(5), 10);
        // console.log("Ping RTT " + elapsed_ms + " ms\n");
        dataChannelLog.textContent += "< pong\n";
        pingLog.textContent = elapsed_ms + " ms\n";
    } else if (message.substring(0, 12) === "server-offer") {
        await handleRenegotiationOffer(message);
        dataChannelLog.textContent += "< server-offer\n";
    } else if (message.substring(0, 13) === "server-answer") {
        await handleServerRenegotiationAnswer(message);
        dataChannelLog.textContent += "< server-answer\n";
    }
}


/**
 * Handles a "server-offer" event, which is send when the server 
 * starts a renegotiation.
 * 
 * Sets the remote description to the offer, creates an answer
 * and sends a "client-answer" to the server
 */
async function handleRenegotiationOffer(message) {
    const offer = JSON.parse(message.substring(12));
    console.log("Received renegotiation offer (\"server-offer\")", offer);

    if (pc && offer !== undefined) {
        console.log("setRemoteDescription");

        // Exception "invalid remapping" if server starts to renegotiating with remapped extmap mappings
        await pc.setRemoteDescription(offer);

        console.log("setLocalDescription and send \"client-answer\" msg");
        await pc.setLocalDescription(await pc.createAnswer());
        dataChannelLog.textContent += "> client-answer\n";
        dc.send("client-answer" + JSON.stringify({
            sdp: pc.localDescription.sdp,
            type: pc.localDescription.type,
        }));
    }
}


/**
 * Handles a "server-answer" event, which is send as a response to 
 * "client-renegotiation-offer".
 * 
 * Sets the remote description
 */
async function handleServerRenegotiationAnswer(message) {
    // handles response to renegotiation started by (this) client
    const answer = JSON.parse(message.substring(13));
    console.log("Received \"server-answer\"", answer);
    await pc.setRemoteDescription(answer);
}


/**
 * Requests a video stream and saves it in localStream, if successful. 
 */
async function loadLocalStream() {
    try {
        const constraints = {
            "video": true,
            "audio": false
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
    } catch (error) {
        console.error("Error opening video camera.", error);
    }
}
