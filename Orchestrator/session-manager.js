const express = require('express');
const cors = require('cors');
const k8s = require('@kubernetes/client-node');
const crypto = require('crypto');
const { createStatelessGuacSession } = require('./guac-json-auth');

// Origines autorisées : WebView Capacitor (iOS = capacitor://localhost, Android = https://localhost)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
	'capacitor://localhost,https://localhost,http://localhost')
	.split(',')
	.map((o) => o.trim())
	.filter(Boolean);

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ['GET', 'POST', 'DELETE'] }));
app.use(express.json());
// navigator.sendBeacon() envoie du text/plain : on l'accepte aussi sur /wipe
app.use(express.text());

// Health check pour le load balancer GCE (Ingress) et la readinessProbe
app.get('/healthz', (req, res) => res.status(200).send('ok'));

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

const NAMESPACE = 'rdp-sessions';
const IMAGE_URI = 'africa-south1-docker.pkg.dev/lab-mobile-rdp-browser/rdp-browser-repo/kiosk-rdp:v1';

async function waitForPodIP(podName, timeoutMs = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const pod = await k8sApi.readNamespacedPod({ name: podName, namespace: NAMESPACE });
		if (pod.status?.phase === 'Running' && pod.status?.podIP) {
			return pod.status.podIP;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('Timeout lors du démarrage du Pod MicroVM');
}

app.post('/session/start', async (req, res) => {
	try {
		const { authToken, screenWidth = 390, screenHeight = 844 } = req.body;
		const sessionId = `rdp-${crypto.randomBytes(6).toString('hex')}`;
		const rdpPassword = crypto.randomBytes(16).toString('hex');
		const targetUrl = `https://tylshiloh.me/auth?token=${encodeURIComponent(authToken)}`;
		const podManifest = {
			metadata: {
				name: sessionId,
				labels: { app: 'kiosk-rdp', session: sessionId },
			},
			spec: {
				runtimeClassName: 'gvisor',
				restartPolicy: 'Never',
				activeDeadlineSeconds: 3600,
				containers: [
					{
						name: 'xrdp-chromium',
						image: IMAGE_URI,
						ports: [{ containerPort: 3389 }],
						env: [
							{ name: 'APP_URL', value: targetUrl },
							{ name: 'RDP_PASSWORD', value: rdpPassword },
						],
						resources: {
							requests: { cpu: '500m', memory: '512Mi' },
							limits: { cpu: '1000m', memory: '1Gi' },
						},
						volumeMounts: [
							{ name: 'dshm', mountPath: '/dev/shm' },
							{ name: 'tmp-ram', mountPath: '/tmp' },
						],
					},
				],
				volumes: [
					{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
					{ name: 'tmp-ram', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
				],
			},
		};
		await k8sApi.createNamespacedPod({ namespace: NAMESPACE, body: podManifest });
		const podIP = await waitForPodIP(sessionId);
		await new Promise((r) => setTimeout(r, 1500));
		const guacamoleUrl = await createStatelessGuacSession({
			sessionId,
			podIP,
			rdpPassword,
			screenWidth,
			screenHeight,
		});
		res.json({ sessionId, guacamoleUrl });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.all('/session/:sessionId/wipe', async (req, res) => {
	try {
		await k8sApi.deleteNamespacedPod({
			name: req.params.sessionId,
			namespace: NAMESPACE,
			gracePeriodSeconds: 0,
		});
		res.json({ status: 'wiped' });
	} catch (err) {
		res.status(500).json({ error: err.message });
	}
});

app.listen(Number(process.env.PORT) || 3000,() => console.log('Orchestrateur RDP actif sur le port 3000'));