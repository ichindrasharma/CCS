import { fetchOrders, PAGE_SIZE } from './api.js';

const STATUSES = ['', 'pending', 'paid', 'shipped', 'cancelled'];

const state = { status: '', page: 1 };

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const day = (iso) => iso.slice(0, 10);

export async function render(root) {
  const { items, total } = await fetchOrders({ status: state.status || undefined, page: state.page });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  root.innerHTML = `
    <label>Status
      <select id="status">${STATUSES.map((s) => `<option value="${s}" ${s === state.status ? 'selected' : ''}>${s || 'all'}</option>`).join('')}</select>
    </label>
    <table>
      <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th><th>Date</th></tr></thead>
      <tbody>${items
        .map((o) => `<tr><td>${o.id}</td><td>${o.userId}</td><td>${o.status}</td><td>${money(o.totalCents)}</td><td>${day(o.createdAt)}</td></tr>`)
        .join('')}</tbody>
    </table>
    <p>
      <button id="prev" ${state.page <= 1 ? 'disabled' : ''}>Previous</button>
      Page ${state.page} of ${pages} (${total} orders)
      <button id="next" ${state.page >= pages ? 'disabled' : ''}>Next</button>
    </p>`;

  root.querySelector('#status').onchange = (e) => ((state.status = e.target.value), (state.page = 1), render(root));
  root.querySelector('#prev').onclick = () => (state.page--, render(root));
  root.querySelector('#next').onclick = () => (state.page++, render(root));
}
