'use client';

import Navbar from '@/components/landing/Navbar';
import HeroSection from '@/components/landing/HeroSection';
import ServicesSection from '@/components/landing/ServicesSection';
import MembershipSection from '@/components/landing/MembershipSection';
import GallerySection from '@/components/landing/GallerySection';
import AnnouncementsSection from '@/components/landing/AnnouncementsSection';
import ContactSection from '@/components/landing/ContactSection';
import Footer from '@/components/landing/Footer';
import MobileCta from '@/components/landing/MobileCta';
import { AccountDeletedNotice } from '@/components/landing/AccountDeletedNotice';
import { useScrollReveal } from '@/hooks/useScrollReveal';
import { usePointerGlow } from '@/hooks/usePointerGlow';
import type { LandingPlan } from '@/lib/landingData';

/**
 * The landing page is only ever the landing page.
 *
 * It used to swap itself for the login or register screen through a `Route`
 * useState, which meant those two screens had no URL, no history entry, no
 * metadata and nothing to deep-link to. They are real routes now, under
 * `app/(auth)/`.
 *
 * Split from `page.tsx` so that PRICES CAN BE FETCHED ON THE SERVER. This
 * half owns the two page-wide browser effects and must stay a client
 * component; the server half above it does the one thing a client component
 * cannot, which is put the real price into the HTML a crawler reads.
 */
export default function LandingPage({
  plans,
  hours,
}: {
  plans: LandingPlan[];
  /** Already summarised, e.g. ['Mon–Sat · 5AM – 10PM', 'Sun · Closed']. */
  hours: string[];
}) {
  // Page-wide effects: one reveal observer and one pointer-glow
  // listener serving every `.rv` / `.glow` element on the page.
  useScrollReveal();
  usePointerGlow();

  return (
    <div
      className="has-mobile-cta"
      style={{ background: 'var(--ground)', minHeight: '100vh', overflowX: 'hidden' }}
    >
      <Navbar />
      <AccountDeletedNotice />
      <main>
        <HeroSection />
        <ServicesSection />
        <MembershipSection plans={plans} />
        <GallerySection />
        <AnnouncementsSection />
        <ContactSection hours={hours} />
      </main>
      <Footer hours={hours} />
      <MobileCta />
    </div>
  );
}
