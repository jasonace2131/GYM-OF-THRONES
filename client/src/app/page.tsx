import LandingPage from '@/components/landing/LandingPage';
import { fetchGymHours, fetchLandingPlans } from '@/lib/livePlans';

/**
 * A SERVER component, purely so the pricing grid can be fetched before the
 * HTML is sent.
 *
 * The page itself is entirely interactive — scroll reveal, pointer glow — and
 * all of that lives in `LandingPage`. The only thing that has to happen on
 * the server is reading the live prices: a client-side fetch would render the
 * grid empty for the first paint and, more importantly, would leave the real
 * price out of the HTML that search engines and link previews read.
 */
export default async function Home() {
  // In parallel: two independent public reads, and the page needs both before
  // it can render anything a search engine should index.
  const [plans, hours] = await Promise.all([fetchLandingPlans(), fetchGymHours()]);
  return <LandingPage plans={plans} hours={hours} />;
}
