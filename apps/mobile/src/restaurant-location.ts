import directory from '../../../config/restaurant-locations.json' with { type: 'json' };

// Presentation only: available branches and order ownership still come from the API.
// Never substitute the first location for an unknown or missing branch.
export function restaurantLocation(branchId: string | null | undefined) {
  return directory.locations.find((location) => location.branch_id === branchId);
}
