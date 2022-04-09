from __future__ import annotations
import logging
import os
import asyncio
import json
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCDataChannel, MediaStreamTrack


# Global variables
root: str
loop: asyncio.AbstractEventLoop
pc: RTCPeerConnection
dc: RTCDataChannel
tasks: list[asyncio.Task]


def main():
    global loop, tasks, root
    tasks = []

    # Set logger for aioice
    logger = logging.getLogger("aioice.ice")
    logger.setLevel(logging.WARNING)

    root = os.path.dirname(__file__)

    loop = asyncio.new_event_loop()

    app = web.Application()
    app.on_shutdown.append(onShutdown)
    app.router.add_get("/", getIndex)
    app.router.add_get("/client.js", getJavascript)
    app.router.add_post("/offer", handleOffer)

    try:
        web.run_app(app, access_log=None,
                    host="127.0.0.1", port=8080, loop=loop)
    except KeyboardInterrupt:
        print("closing")
        onShutdown(None)
        exit()


async def onShutdown(app):
    global pc, tasks
    if pc:
        await pc.close()
    await asyncio.gather(*tasks)


def getIndex(request):
    """Returns index.html"""
    global root
    content = open(os.path.join(root, "index.html"), "r").read()
    return web.Response(content_type="text/html", text=content)


def getJavascript(request):
    """Returns client.js"""
    global root
    content = open(os.path.join(root, "client.js"), "r").read()
    return web.Response(content_type="application/javascript", text=content)


async def handleOffer(request):
    """
    Handler for /offer endpoint.
    This endpoint is only called once for the initial negotiation.
    After that, the datachannel is used for signaling.
    """
    global pc

    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    # In case a new user connects
    print("Received offer")
    pc = RTCPeerConnection()

    # Register event handlers
    @pc.on("datachannel")
    def onDatachannel(channel: RTCDataChannel):
        global dc, loop
        dc = channel

        @dc.on("message")
        def onMessage(message):
            if not isinstance(message, str):
                print("[ERROR]: received message is not a string. type:",
                      type(message))
                return

            # Find correct handler for message
            # Because this function cannot be asnyc, create_task is used to call the async functions
            if message.startswith("ping"):
                dc.send("pong" + message[4:])
            elif message.startswith("client-answer"):
                tasks.append(loop.create_task(
                    handleRenegotiationAnswer(message)
                ))
            elif message.startswith("client-renegotiation-offer"):
                tasks.append(loop.create_task(
                    handleRenegotiationOffer(message)
                ))
            elif message == "request-renegotiation":
                # This message is send by the client to trigger
                # a renegotiation started by the server
                print("[PC] Received request-renegotiation")
                tasks.append(loop.create_task(
                    sendRenegotiationOffer()
                ))

    @pc.on("connectionstatechange")
    async def onConnectionStateChange():
        global pc
        print(f"[PC] Connection state is {pc.connectionState}")
        if pc.connectionState == "failed":
            await pc.close()

    @pc.on("track")
    def onTrack(track: MediaStreamTrack):
        global pc
        print(f"[PC] {track.kind} Track received", )

        if track.kind == "audio":
            print("[ERROR] NOT IMPLEMENTED")
        elif track.kind == "video":
            pc.addTrack(track)

        @track.on("ended")
        async def onEnded():
            print(f"[PC] {track.kind} Track ended")
            track.stop()

    # handle offer
    await pc.setRemoteDescription(offer)

    # send answer
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        }),
    )


async def handleRenegotiationAnswer(message: str):
    """Handles the client answer to a renegotiation offer initiated by the server"""
    global pc
    print("[PC] Received \"client-answer\" message")
    params = json.loads(message[13:])
    answer = RTCSessionDescription(sdp=params["sdp"],
                                   type=params["type"])
    await pc.setRemoteDescription(answer)


async def handleRenegotiationOffer(message: str):
    """Handles a renegotiation offer initiated by the client"""
    global pc, dc

    print("[PC] Received \"client-renegotiation-offer\" message")
    params = json.loads(message[26:])
    offer = RTCSessionDescription(sdp=params["sdp"],
                                  type=params["type"])
    await pc.setRemoteDescription(offer)
    await pc.setLocalDescription(await pc.createAnswer())
    dc.send("server-answer" + json.dumps({
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    }))


async def sendRenegotiationOffer():
    """Starts a renegotiation with the given user by sending a new offer"""
    global pc, dc

    print("[PC] Start renegotiation")
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    print("[PC] Sending renegotiation offer")
    dc.send("server-offer" + json.dumps({
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    }))

if __name__ == "__main__":
    main()
