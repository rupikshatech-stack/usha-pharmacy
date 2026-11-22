import { useState, lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Spinner } from '../../components/common/ui';
import LandingNav from '../../components/landing/LandingNav';
import BackdropLayers from '../../components/landing/BackdropLayers';
import Scene3DDock from '../../components/landing/scene3d/Scene3DDock';
import Hero from '../../components/landing/Hero';
import ZoomSplitScene from '../../components/landing/zoom/ZoomSplitScene';
import StatsRow from '../../components/landing/StatsRow';
import LaptopStage from '../../components/landing/LaptopStage';
import ModulesGrid from '../../components/landing/ModulesGrid';
import WhyThisExists from '../../components/landing/WhyThisExists';
import ProductShowcase from '../../components/landing/ProductShowcase/ProductShowcase';
import Audiences from '../../components/landing/Audiences';
import HowItWorks from '../../components/landing/HowItWorks';
import ClosingCta from '../../components/landing/ClosingCta';
import '../../components/landing/landing.css';

// three.js is ~520 KB: it must stay behind a dynamic import or it lands in the counter app's bundle.
const PharmacyScene3D = lazy(() => import('../../components/landing/scene3d/PharmacyScene3D'));

/** The public front door. Signed-in visitors skip it and go straight to the application. */
export default function Landing() {
  const { user, loading } = useAuth();
  const [preset, setPreset] = useState('emerald');
  const [manualExplode, setManualExplode] = useState(false);

  if (loading) return <Spinner />;
  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : '/dashboard'} replace />;

  return (
    <div className="landing min-h-full text-ink">
      {/* porcelain gradient + forest crossfade, then the capsule, then the page */}
      <BackdropLayers />
      <Suspense fallback={null}>
        <PharmacyScene3D preset={preset} manualExplode={manualExplode} />
      </Suspense>

      <div className="relative z-10">
        <LandingNav />
        <main>
          <Hero />
          <ZoomSplitScene />
          <StatsRow />
          <LaptopStage />
          <ModulesGrid />
          <WhyThisExists />
          <ProductShowcase />
          <Audiences />
          <HowItWorks />
          <ClosingCta />
        </main>
      </div>

      <Scene3DDock
        preset={preset}
        onPreset={setPreset}
        manualExplode={manualExplode}
        onExplode={setManualExplode}
      />
    </div>
  );
}
