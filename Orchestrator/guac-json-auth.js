const crypto = require('crypto');
const axios = require('axios');
const GUAC_URL = process.env.GUAC_URL || 'http://guacamole-service.guacamole-system:8080/guacamole';
const JSON_SECRET_KEY = process.env.JSON_SECRET_KEY;

function signGuacamolePayload(payloadObject, hexSecretKey) {
	const keyBuffer = Buffer.from(hexSecretKey, 'hex');
	const jsonString = JSON.stringify(payloadObject);
	const hmac = crypto.createHmac('sha256', keyBuffer);
	hmac.update(jsonString, 'utf8');
	const signatureBuffer = hmac.digest();
	const combinedBuffer = Buffer.concat([
		signatureBuffer,
		Buffer.from(jsonString, 'utf8'),
	]);
	const iv = Buffer.alloc(16, 0);
	const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, iv);
	const encryptedBuffer = Buffer.concat([
		cipher.update(combinedBuffer),
		cipher.final(),
	]);
	return encryptedBuffer.toString('base64');
}

async function createStatelessGuacSession({
	sessionId,
	podIP,
	rdpPassword,
	screenWidth,
	screenHeight,
}) {
	const payload = {
		username: sessionId,
		expires: Date.now() + 60 * 60 * 1000,
		connections: {
			[sessionId]: {
				protocol: 'rdp',
				parameters: {
					hostname: podIP,
					port: '3389',
					username: 'rdpuser',
					password: rdpPassword,
					security: 'any',
					'ignore-cert': 'true',
					width: String(screenWidth),
					height: String(screenHeight),
					dpi: '96',
					'resize-method': 'display-update',
				},
			},
		},
	};
	const encryptedData = signGuacamolePayload(payload, JSON_SECRET_KEY);
	const params = new URLSearchParams();
	params.append('data', encryptedData);
	const response = await axios.post(`${GUAC_URL}/api/tokens`, params);
	const { authToken } = response.data;
	const clientIdentifier = Buffer.from(`${sessionId}cjson`).toString('base64');
	return `${GUAC_URL}/#/client/${clientIdentifier}?token=${authToken}`;
}

module.exports = { createStatelessGuacSession };
