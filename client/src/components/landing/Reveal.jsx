import { motion } from 'motion/react';

/*
 * A scroll reveal, to the brief's timing.
 *
 * NOTE: most sections on this page already reveal through `useRise` (GSAP ScrollTrigger on `[data-rise]`).
 * This component is used where there is no `data-rise` yet, so nothing animates twice. If the two should
 * become one system, migrate `useRise` to this rather than stacking them.
 */
export default function Reveal({ as = 'div', children, className = '', delay = 0, ...rest }) {
  const Tag = motion[as] || motion.div;
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1], delay }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
