/** Standard paginated response shape used by every list endpoint. */
export const paginated = (items, { page, limit, total }) => ({
  items,
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});
