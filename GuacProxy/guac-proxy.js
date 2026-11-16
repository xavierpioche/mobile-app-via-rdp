// Proxy WebSocket sans état entre guacamole-common-js et guacd.
//
// Remplace l'application web Apache Guacamole (Tomcat) : aucun jeton n'est gardé
// en mémoire. Les paramètres de connexion (IP du Pod, mot de passe RDP, taille
// d'écran) arrivent chiffrés (AES-256-GCM) dans l'URL du WebSocket ; n'importe
// quel réplica peut les déchiffrer et ouvrir la connexion vers son guacd local.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT) || 4822;
const TUNNEL_PATH = process.env.TUNNEL_PATH || '/tunnel';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
	'capacitor://localhost,https://localhost,http://localhost')
	.split(',').map((o) => o.trim()).filter(Boolean);
// Au-delà, on suspend la lecture de guacd le temps que le client rattrape son retard
const WS_HIGH_WATER = 8 * 1024 * 1024;

const SECRET_HEX = process.env.TUNNEL_SECRET || '';
if (!/^[0-9a-f]{64}$/i.test(SECRET_HEX)) {
	throw new Error('TUNNEL_SECRET doit contenir 32 octets en hexadécimal (64 caractères)');
}
const KEY = Buffer.from(SECRET_HEX, 'hex');

// ---------------------------------------------------------------------------
// Jeton de tunnel : base64url( iv[12] | tag[16] | AES-256-GCM(JSON) )

function decodeTunnelToken(token) {
	if (typeof token !== 'string' || token.length > 2048) throw new Error('jeton absent');
	const buf = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	if (buf.length < 29) throw new Error('jeton trop court');
	const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
	decipher.setAuthTag(buf.subarray(12, 28));
	const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
	const c = JSON.parse(json);
	if (typeof c.exp !== 'number' || c.exp < Math.floor(Date.now() / 1000)) throw new Error('jeton expiré');
	if (!c.sid || !c.host || !c.pass) throw new Error('jeton incomplet');
	return c;
}

// ---------------------------------------------------------------------------
// Protocole Guacamole : instructions "LEN.VALEUR,LEN.VALEUR;" où LEN compte
// des points de code Unicode (et non des unités UTF-16).

const codepoints = (s) => {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0xD800 || c > 0xDBFF) n++;
	}
	return n;
};
const encodeInstruction = (...elements) =>
	elements.map((e) => { const s = String(e); return `${codepoints(s)}.${s}`; }).join(',') + ';';

// Avance de n points de code depuis start ; -1 si les données ne sont pas encore arrivées
function advance(buf, start, n) {
	const slice = buf.slice(start, start + n);
	if (slice.length < n) return -1;
	if (!/[\uD800-\uDBFF]/.test(slice)) return start + n;
	let i = start;
	for (let c = 0; c < n; c++) {
		if (i >= buf.length) return -1;
		const code = buf.charCodeAt(i);
		i += code >= 0xD800 && code <= 0xDBFF ? 2 : 1;
	}
	return i > buf.length ? -1 : i;
}

// Parcourt le tampon. Renvoie la fin de la dernière instruction complète et,
// si demandé, les instructions décodées (au plus `max`).
function scan(buf, { parse = false, max = Infinity } = {}) {
	let i = 0;
	let lastEnd = 0;
	let elements = [];
	const instructions = [];
	while (i < buf.length && instructions.length < max) {
		const dot = buf.indexOf('.', i);
		if (dot === -1) break;
		const lenStr = buf.slice(i, dot);
		if (!/^\d{1,10}$/.test(lenStr)) throw new Error('instruction Guacamole invalide');
		const end = advance(buf, dot + 1, Number(lenStr));
		if (end === -1 || end >= buf.length) break;
		if (parse) elements.push(buf.slice(dot + 1, end));
		const terminator = buf[end];
		i = end + 1;
		if (terminator === ';') {
			lastEnd = i;
			if (parse) { instructions.push(elements); elements = []; }
		} else if (terminator !== ',') {
			throw new Error('instruction Guacamole invalide');
		}
	}
	return { lastEnd, instructions };
}

// ---------------------------------------------------------------------------

function rdpParameters(c) {
	return {
		hostname: c.host,
		port: String(c.port || 3389),
		username: c.user || 'rdpuser',
		password: c.pass,
		security: 'any',
		'ignore-cert': 'true',
		width: String(c.width),
		height: String(c.height),
		dpi: String(c.dpi || 96),
		'resize-method': 'display-update',
		'disable-audio': 'true',
	};
}

function handleTunnel(ws, claims) {
	const tag = `[tunnel ${claims.sid}]`;
	const uuid = crypto.randomUUID();
	const decoder = new StringDecoder('utf8');
	const guacd = net.connect(GUACD_PORT, GUACD_HOST);
	let buffer = '';
	let phase = 'args'; // args -> ready -> stream
	let closed = false;

	const closeAll = (code, reason) => {
		if (closed) return;
		closed = true;
		guacd.destroy();
		if (ws.readyState === ws.OPEN) ws.close(code, reason);
		console.log(`${tag} fermé (${reason})`);
	};

	const sendToClient = (data) => {
		if (ws.readyState !== ws.OPEN) return;
		ws.send(data);
		if (ws.bufferedAmount > WS_HIGH_WATER && !guacd.isPaused()) {
			guacd.pause();
			const timer = setInterval(() => {
				if (closed || ws.bufferedAmount < WS_HIGH_WATER / 2) {
					clearInterval(timer);
					if (!closed) guacd.resume();
				}
			}, 50);
		}
	};

	guacd.setNoDelay(true);
	guacd.on('connect', () => guacd.write(encodeInstruction('select', 'rdp')));

	guacd.on('data', (chunk) => {
		buffer += decoder.write(chunk);
		try {
			// Poignée de main : on consomme "args" puis "ready" sans les transmettre
			while (phase !== 'stream') {
				const { lastEnd, instructions } = scan(buffer, { parse: true, max: 1 });
				if (!instructions.length) return;
				buffer = buffer.slice(lastEnd);
				const [opcode, ...args] = instructions[0];

				if (opcode === 'error') {
					sendToClient(encodeInstruction(opcode, ...args));
					return closeAll(1011, `erreur guacd : ${args[0]}`);
				}
				if (phase === 'args' && opcode === 'args') {
					const hasVersion = args[0] && args[0].startsWith('VERSION_');
					const names = hasVersion ? args.slice(1) : args;
					const params = rdpParameters(claims);
					guacd.write(encodeInstruction('size', claims.width, claims.height, claims.dpi || 96));
					guacd.write(encodeInstruction('audio'));
					guacd.write(encodeInstruction('video'));
					guacd.write(encodeInstruction('image', 'image/png', 'image/jpeg', 'image/webp'));
					if (hasVersion) {
						guacd.write(encodeInstruction('timezone', 'UTC'));
						guacd.write(encodeInstruction('name', claims.sid));
					}
					const values = names.map((n) => params[n] ?? '');
					guacd.write(encodeInstruction('connect', ...(hasVersion ? [args[0]] : []), ...values));
					phase = 'ready';
				} else if (phase === 'ready' && opcode === 'ready') {
					// Comme Tomcat : envoie l'identifiant du tunnel (opcode interne "")
					sendToClient(encodeInstruction('', uuid));
					phase = 'stream';
					console.log(`${tag} connecté à ${claims.host}`);
				}
			}

			// Flux : ne transmettre que des instructions complètes
			const { lastEnd } = scan(buffer);
			if (lastEnd > 0) {
				sendToClient(buffer.slice(0, lastEnd));
				buffer = buffer.slice(lastEnd);
			}
		} catch (err) {
			closeAll(1011, err.message);
		}
	});

	ws.on('message', (data) => {
		const msg = data.toString();
		// Instructions internes du client (opcode vide) : ping à renvoyer, jamais à guacd
		if (msg.startsWith('0.,')) {
			if (msg.startsWith('0.,4.ping,')) ws.send(msg);
			return;
		}
		if (phase === 'stream') guacd.write(msg);
	});

	ws.on('close', () => closeAll(1000, 'client parti'));
	ws.on('error', () => closeAll(1011, 'erreur WebSocket'));
	guacd.on('error', (err) => closeAll(1011, `guacd : ${err.message}`));
	guacd.on('close', () => closeAll(1000, 'guacd a fermé la connexion'));
}

// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
	if (req.url === '/healthz') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		return res.end('ok');
	}
	res.writeHead(404);
	res.end();
});

const wss = new WebSocketServer({
	noServer: true,
	maxPayload: 1024 * 1024,
	// guacamole-common-js demande le sous-protocole "guacamole"
	handleProtocols: (protocols) => (protocols.has('guacamole') ? 'guacamole' : false),
});

server.on('upgrade', (req, socket, head) => {
	const reject = (status, why) => {
		console.warn(`[upgrade] refus ${status} : ${why}`);
		socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	};
	const url = new URL(req.url, 'http://localhost');
	if (url.pathname !== TUNNEL_PATH) return reject('404 Not Found', url.pathname);
	const origin = req.headers.origin;
	if (origin && !ALLOWED_ORIGINS.includes(origin)) return reject('403 Forbidden', `origine ${origin}`);

	let claims;
	try {
		claims = decodeTunnelToken(url.searchParams.get('token'));
	} catch (err) {
		return reject('403 Forbidden', err.message);
	}
	wss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws, claims));
});

server.listen(PORT, () => console.log(`Proxy Guacamole sans état sur le port ${PORT}${TUNNEL_PATH}`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
