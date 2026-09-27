/**
 * Share Call — WebRTC HQ + сигналинг через Share Server
 */

export type CallHandlers = {
  onRemoteStream: (stream: MediaStream) => void;
  onLocalStream: (stream: MediaStream) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
  onStatus: (s: string) => void;
  onIncoming?: (from: string, video: boolean) => void;
  onConnected?: () => void;
};

type SignalPayload = {
  type: string;
  from?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  video?: boolean;
};

const ICE: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 30 },
};

export class ShareCall {
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  private me: string;
  private peer: string;
  private handlers: CallHandlers;
  private polite: boolean;
  private makingOffer = false;
  private send: (to: string, payload: SignalPayload) => void;
  private connectedFired = false;

  constructor(
    meId: string,
    peerId: string,
    handlers: CallHandlers,
    sendSignal: (to: string, payload: SignalPayload) => void,
  ) {
    this.me = meId;
    this.peer = peerId;
    this.handlers = handlers;
    this.send = sendSignal;
    this.polite = meId < peerId;
  }

  handleSignal(payload: SignalPayload) {
    void this.onSignal(payload);
  }

  async listenOnly() {
    /* waiting for ring */
  }

  async start(video: boolean, asCaller = true) {
    this.handlers.onStatus(asCaller ? "ожидание…" : "соединение…");
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: video ? VIDEO_CONSTRAINTS : false,
    });
    this.handlers.onLocalStream(this.local);

    this.pc = new RTCPeerConnection(ICE);
    this.local.getTracks().forEach((t) => this.pc!.addTrack(t, this.local!));

    // Prefer higher bitrate when possible
    this.pc.getSenders().forEach((sender) => {
      if (!sender.track) return;
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      if (sender.track.kind === "video") {
        params.encodings[0].maxBitrate = 2_500_000;
        params.encodings[0].maxFramerate = 30;
      } else {
        params.encodings[0].maxBitrate = 128_000;
      }
      void sender.setParameters(params).catch(() => {});
    });

    this.pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      if (stream) this.handlers.onRemoteStream(stream);
    };
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.send(this.peer, { type: "ice", candidate: ev.candidate });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === "connected") {
        this.handlers.onStatus("connected");
        if (!this.connectedFired) {
          this.connectedFired = true;
          this.handlers.onConnected?.();
        }
      }
      if (s === "failed") this.handlers.onError("Связь оборвалась");
      if (s === "disconnected") this.handlers.onStatus("переподключение…");
    };

    if (asCaller) {
      this.send(this.peer, { type: "ring", video });
      setTimeout(() => void this.makeOffer(), 350);
    }
  }

  async accept(video: boolean) {
    await this.start(video, false);
    this.send(this.peer, { type: "accept" });
  }

  reject() {
    this.send(this.peer, { type: "reject" });
    this.hangup(false);
  }

  setMuted(muted: boolean) {
    this.local?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  setVideoEnabled(enabled: boolean) {
    this.local?.getVideoTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  private async makeOffer() {
    if (!this.pc) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await this.pc.setLocalDescription(offer);
      this.send(this.peer, { type: "sdp", sdp: this.pc.localDescription || undefined });
    } finally {
      this.makingOffer = false;
    }
  }

  private async onSignal(payload: SignalPayload) {
    if (!payload) return;
    if (payload.type === "ring") {
      this.handlers.onIncoming?.(this.peer, !!payload.video);
      this.handlers.onStatus("входящий…");
      return;
    }
    if (payload.type === "reject") {
      this.handlers.onStatus("Отклонён");
      this.hangup(false);
      return;
    }
    if (payload.type === "accept") {
      this.handlers.onStatus("соединение…");
      return;
    }
    if (!this.pc) return;
    if (payload.type === "sdp" && payload.sdp) {
      const ready =
        !this.makingOffer &&
        (this.pc.signalingState === "stable" || this.pc.signalingState === "have-local-offer");
      if (!this.polite && payload.sdp.type === "offer" && !ready) return;
      await this.pc.setRemoteDescription(payload.sdp);
      if (payload.sdp.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.send(this.peer, { type: "sdp", sdp: this.pc.localDescription || undefined });
      }
    }
    if (payload.type === "ice" && payload.candidate) {
      try {
        await this.pc.addIceCandidate(payload.candidate);
      } catch {
        /* */
      }
    }
    if (payload.type === "end") this.hangup(false);
  }

  hangup(notify = true) {
    if (notify) this.send(this.peer, { type: "end" });
    this.local?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.pc = null;
    this.local = null;
    this.handlers.onEnded();
  }
}
