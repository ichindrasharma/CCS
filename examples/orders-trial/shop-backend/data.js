// Sample data for the shop API. Stored the way the database returns it: snake_case, cents.

export const ORDER_STATUS = ['pending', 'paid', 'shipped', 'cancelled'];

const customers = ['u_101', 'u_102', 'u_103', 'u_104'];

export const orders = Array.from({ length: 30 }, (_, i) => ({
  order_id: `ord_${String(1001 + i)}`,
  user_id: customers[i % customers.length],
  status: ORDER_STATUS[(i * 7) % ORDER_STATUS.length],
  total_cents: 1500 + ((i * 2731) % 18000),
  created_at: new Date(Date.UTC(2026, 8, 1 + i, 9, 30)).toISOString(),
}));
