const crypto = require('crypto');

// Clé partagée avec le proxy Guacamole (GuacProxy) : 32 octets en hexadécimal.
const SECRET_HEX = process.env.TUNNEL_SECRET || '';
if (!/^[0-9a-f]{64}$/i.test(SECRET_HEX)) {
	throw new Error('TUNNEL_SECRET doit contenir 32 octets en hexadécimal (64 caractères)');
}
const KEY = Buffer.from(SECRET_HEX, 'hex');
// Délai pour ouvrir le WebSocket ; une connexion établie n'est pas coupée à l'expiration.
const TUNNEL_TOKEN_TTL = Number(process.env.TUNNEL_TOKEN_TTL_SECONDS) || 30;

const b64url = (buf) => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Jeton de tunnel : base64url( iv[12] | tag[16] | AES-256-GCM(JSON) ).
// Chiffré et authentifié : le client ne voit ni l'IP du Pod ni le mot de passe RDP,
// et ne peut rien modifier. Sans état : tout réplica du proxy peut le déchiffrer.
function createTunnelToken({ sessionId, podIP, rdpPassword, screenWidth, screenHeight, dpi = 96 }) {
	const payload = {
		sid: sessionId,
		host: podIP,
		port: 3389,
		user: 'rdpuser',
		pass: rdpPassword,
		width: screenWidth,
		height: screenHeight,
		dpi,
		exp: Math.floor(Date.now() / 1000) + TUNNEL_TOKEN_TTL,
	};
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
	const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
	return b64url(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

module.exports = { createTunnelToken };
