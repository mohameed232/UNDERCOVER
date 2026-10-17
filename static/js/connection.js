(function () {
  "use strict";

  class RoomConnection {
    constructor(credentials, callbacks) {
      this.credentials = credentials;
      this.callbacks = callbacks;
      this.socket = null;
      this.stopped = false;
      this.polling = false;
      this.pollBusy = false;
      this.actionBusy = false;
      this.failures = 0;
      this.lastFrame = Date.now();
      this.requests = new Set();
    }

    start() {
      this.callbacks.status("جارٍ الاتصال…", true);
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}/ws/${this.credentials.room_code}`);
      this.socket = socket;
      this.connectTimer = setTimeout(() => this.usePolling(), 4000);
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        socket.send(JSON.stringify({ type: "auth", ...this.credentials }));
      });
      socket.addEventListener("message", event => {
        if (this.stopped || this.socket !== socket) return;
        this.lastFrame = Date.now();
        let message;
        try { message = JSON.parse(event.data); } catch { return this.usePolling(); }
        if (message.type === "pong") return;
        if (message.type === "error") return this.callbacks.error(message.message);
        if (message.type !== "state") return;
        clearTimeout(this.connectTimer);
        this.acceptState(message);
      });
      socket.addEventListener("close", event => {
        if (this.stopped || this.socket !== socket) return;
        if ([4001, 4003, 4403, 4404].includes(event.code)) {
          return this.end(event.code === 4001 ? "opened_elsewhere" : event.code === 4404 ? "missing" : "invalid");
        }
        this.usePolling();
      });
      this.heartbeat = setInterval(() => this.resume(), 15000);
    }

    acceptState(state) {
      if (this.stopped) return;
      this.failures = 0;
      this.callbacks.status("متصل", false);
      this.callbacks.state(state);
    }

    usePolling() {
      if (this.stopped || this.polling) return;
      this.polling = true;
      clearTimeout(this.connectTimer);
      clearInterval(this.heartbeat);
      const previous = this.socket;
      this.socket = null;
      previous?.close();
      this.poll();
    }

    async request(suffix, message) {
      const controller = new AbortController();
      this.requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`/api/rooms/${this.credentials.room_code}/${suffix}`, {
          method: message ? "POST" : "GET",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.credentials.token}`,
            "X-Undercover-Player": this.credentials.player_id
          },
          body: message ? JSON.stringify(message) : undefined,
          signal: controller.signal
        });
        const body = await response.json();
        if (!response.ok) {
          if ([401, 404].includes(response.status)) this.end(response.status === 404 ? "missing" : "invalid");
          throw new Error(body.detail || "تعذر إكمال الطلب.");
        }
        return body;
      } finally {
        clearTimeout(timeout);
        this.requests.delete(controller);
      }
    }

    async poll() {
      clearTimeout(this.pollTimer);
      if (this.stopped || this.pollBusy) return;
      this.pollBusy = true;
      try {
        this.acceptState(await this.request("state"));
      } catch {
        if (!this.stopped) {
          this.failures += 1;
          this.callbacks.status("انقطع الاتصال · نحاول مجددًا", true);
        }
      } finally {
        this.pollBusy = false;
        if (!this.stopped) this.pollTimer = setTimeout(() => this.poll(), Math.min(1500 * 2 ** this.failures, 10000));
      }
    }

    async send(message) {
      if (this.stopped || this.actionBusy) return;
      if (!this.polling && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
        return;
      }
      if (!this.polling) return this.callbacks.error("انتظر حتى يكتمل الاتصال.");
      this.actionBusy = true;
      try {
        this.acceptState(await this.request("actions", message));
      } catch (error) {
        if (!this.stopped) {
          this.callbacks.error(error.name === "AbortError" || error instanceof TypeError
            ? "تعذر تأكيد الإجراء. نتحقق من حالة الغرفة؛ انتظر قليلًا." : error.message);
        }
      } finally {
        this.actionBusy = false;
        // Read the server's state after an uncertain response; never replay a vote or host action.
        if (!this.stopped) this.poll();
      }
    }

    resume() {
      if (this.stopped) return;
      if (this.polling) return this.poll();
      if (Date.now() - this.lastFrame > 35000) return this.usePolling();
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "ping" }));
    }

    end(reason) {
      this.stop();
      this.callbacks.end(reason);
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.connectTimer);
      clearTimeout(this.pollTimer);
      clearInterval(this.heartbeat);
      for (const request of this.requests) request.abort();
      this.socket?.close();
      this.socket = null;
    }
  }

  window.RoomConnection = RoomConnection;
}());
