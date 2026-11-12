import { verifySession } from '../auth/session';
import { checkout } from '../checkout';
import type { Order } from '../types';

export async function handleCheckoutRequest(req: { token: string; order: Order }) {
  const userId = verifySession(req.token);
  if (!userId) return { status: 401 };
  const receipt = await checkout(req.order);
  return { status: 200, body: receipt };
}
