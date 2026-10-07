// Optional private dynamic QR routes. Never tracks payments or persists cashier headers.
export function createQrRouter({ Router, bankUrl, signedHeaders, decryptSecret, fetcher = fetch }) {
  const router = Router();
  router.use((req, res, next) => {
    const session = {
      tokenSN: req.headers['x-token-sn'],
      profileId: req.headers['x-profile-id'] || null,
      vtokenSecret: req.headers['x-vtoken-secret'],
    };
    if (
      typeof session.tokenSN !== 'string' ||
      !session.tokenSN ||
      typeof session.vtokenSecret !== 'string' ||
      !session.vtokenSecret
    )
      return res.status(401).json({ error: 'SESSION_REQUIRED' });
    try {
      session.decryptedSecret = decryptSecret(session.vtokenSecret);
    } catch {
      return res.status(401).json({ error: 'SESSION_INVALID' });
    }
    req.session = session;
    next();
  });
  const forward = async (req, res, path, body) => {
    try {
      const url = bankUrl + path;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const response = await fetcher(url, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          ...signedHeaders(url, req.session, payload),
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const answer = await response.json();
      if (!response.ok || !answer || typeof answer !== 'object' || Array.isArray(answer))
        return res.status(502).json({ error: 'BANK_UNCERTAIN' });
      // Preserve bank token, amount, expiry and status verbatim for the durable worker.
      return res.json(answer);
    } catch {
      return res.status(502).json({ error: 'BANK_UNCERTAIN' });
    }
  };
  router.post('/create', (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['amount', 'latitude', 'longitude'].includes(key)) ||
      !Number.isSafeInteger(body.amount) ||
      body.amount <= 0 ||
      !Number.isFinite(body.latitude) ||
      Math.abs(body.latitude) > 90 ||
      !Number.isFinite(body.longitude) ||
      Math.abs(body.longitude) > 180
    )
      return res.status(400).json({ error: 'INVALID_QR_REQUEST' });
    return forward(req, res, '/v01/qr-token/create', {
      PaymentAmount: body.amount,
      DeviceInterface: 'Pos',
      Latitude: body.latitude,
      Longitude: body.longitude,
    });
  });
  router.get('/status', (req, res) => {
    const id = req.query.qrOperationId;
    if (
      Object.keys(req.query).some((key) => key !== 'qrOperationId') ||
      typeof id !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(id)
    )
      return res.status(400).json({ error: 'INVALID_QR_OPERATION_ID' });
    return forward(req, res, '/v02/kaspi-qr/status?qrOperationId=' + id);
  });
  return router;
}
