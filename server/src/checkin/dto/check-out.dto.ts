import { IsUUID } from 'class-validator';

/**
 * `POST /api/v1/checkin/checkout` — the member confirms the check-out a second
 * scan offered them.
 *
 * Only the visit id. There is no `userId` — identity comes from the JWT, and
 * the service refuses any visit that is not the caller's own — and no station
 * token: the proof that the member is at the gym is the `ALREADY_INSIDE` scan
 * they made moments ago, which the server already holds.
 */
export class CheckOutDto {
  @IsUUID()
  checkInId!: string;
}
