import { connect as connectNet, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

export type EmailMessage = {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type EmailProvider = {
  send(message: EmailMessage): Promise<{ id?: string }>;
};

export class EmailDeliveryFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmailDeliveryFailure";
  }
}

export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.resend.com/emails",
  ) {}

  async send(message: EmailMessage) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new EmailDeliveryFailure(
        `Resend rejected email (${response.status})`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined,
      );
    }
    const body = await response.json() as { id?: string };
    return { id: body.id };
  }
}

export type SmtpOptions = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  secure: boolean;
  from: string;
};

type SmtpSocket = Socket | TLSSocket;

function smtpResponse(socket: SmtpSocket) {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      const last = lines.at(-1);
      if (last && /^\d{3} /.test(last)) {
        socket.off("data", onData);
        resolve(last);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function smtpCommand(socket: SmtpSocket, command: string, expected: number[]) {
  socket.write(`${command}\r\n`);
  const response = await smtpResponse(socket);
  const code = Number(response.slice(0, 3));
  if (!expected.includes(code)) throw new EmailDeliveryFailure(`SMTP command failed (${code})`, code >= 500);
}

function messageId(idempotencyKey: string) {
  const safeKey = idempotencyKey.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `<${safeKey}@restar>`;
}

export class SmtpEmailProvider implements EmailProvider {
  constructor(private readonly options: SmtpOptions) {}

  async send(message: EmailMessage) {
    const socket = await new Promise<SmtpSocket>((resolve, reject) => {
      const connected = this.options.secure
        ? connectTls({ host: this.options.host, port: this.options.port })
        : connectNet({ host: this.options.host, port: this.options.port });
      connected.once("error", reject);
      connected.once(this.options.secure ? "secureConnect" : "connect", () => resolve(connected));
    });

    try {
      const greeting = await smtpResponse(socket);
      if (Number(greeting.slice(0, 3)) !== 220) throw new EmailDeliveryFailure("SMTP greeting failed", true);
      await smtpCommand(socket, "EHLO restar", [250]);
      if (this.options.username && this.options.password) {
        await smtpCommand(socket, "AUTH LOGIN", [334]);
        await smtpCommand(socket, Buffer.from(this.options.username).toString("base64"), [334]);
        await smtpCommand(socket, Buffer.from(this.options.password).toString("base64"), [235]);
      }
      await smtpCommand(socket, `MAIL FROM:<${this.options.from}>`, [250]);
      await smtpCommand(socket, `RCPT TO:<${message.to}>`, [250, 251]);
      socket.write("DATA\r\n");
      const dataResponse = await smtpResponse(socket);
      if (Number(dataResponse.slice(0, 3)) !== 354) throw new EmailDeliveryFailure("SMTP DATA command failed", true);
      const id = messageId(message.idempotencyKey);
      const body = [
        `From: ${message.from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        `Message-ID: ${id}`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="restar-boundary"',
        "",
        "--restar-boundary",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        message.text,
        "--restar-boundary",
        'Content-Type: text/html; charset="utf-8"',
        "",
        message.html,
        "--restar-boundary--",
      ].join("\r\n").replace(/^\./gm, "..");
      socket.write(`${body}\r\n.\r\n`);
      const sentResponse = await smtpResponse(socket);
      if (Number(sentResponse.slice(0, 3)) !== 250) throw new EmailDeliveryFailure("SMTP message delivery failed", true);
      await smtpCommand(socket, "QUIT", [221]);
      return { id };
    } finally {
      socket.destroy();
    }
  }
}

export function createEmailProvider(): EmailProvider {
  const provider = process.env.EMAIL_PROVIDER ?? (process.env.RESEND_API_KEY ? "resend" : "smtp");
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is required");
  if (provider === "resend") {
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required for Resend email delivery");
    return new ResendEmailProvider(process.env.RESEND_API_KEY);
  }
  if (provider !== "smtp") throw new Error(`Unsupported email provider: ${provider}`);
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error("SMTP_HOST is required for SMTP email delivery");
  return new SmtpEmailProvider({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    username: process.env.SMTP_USERNAME,
    password: process.env.SMTP_PASSWORD,
    secure: process.env.SMTP_SECURE === "true",
    from,
  });
}
