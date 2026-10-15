// Gym services/programs domain types

export interface GymService {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
