// Data access for the orders page.

export const API_URL = 'http://localhost:3001';

/**
 * @typedef {{ id: string, userId: string, status: string, totalCents: number, createdAt: string }} Order
 * @typedef {{ items: Order[], total: number }} OrdersPage
 */

export const PAGE_SIZE = 10;

const MOCK_STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];
const MOCK = Array.from({ length: 23 }, (_, i) => ({
  id: `mock_${i + 1}`,
  userId: `u_${100 + (i % 3)}`,
  status: MOCK_STATUSES[i % MOCK_STATUSES.length],
  totalCents: 999 + i * 250,
  createdAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
}));

/**
 * Orders for one page, optionally filtered by status.
 * TODO: integrate with the backend. This still returns mock data.
 *
 * @param {{ status?: string, page: number }} query  page is 1-based
 * @returns {Promise<OrdersPage>}
 */
export async function fetchOrders({ status, page }) {
  const filtered = status ? MOCK.filter((o) => o.status === status) : MOCK;
  const start = (page - 1) * PAGE_SIZE;
  return { items: filtered.slice(start, start + PAGE_SIZE), total: filtered.length };
}
