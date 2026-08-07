/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect } from "react";

interface Particle {
  xSpace: number; // original 3D position
  ySpace: number;
  zSpace: number;
  currX: number; // current 2D screen coordinates
  currY: number;
  vx: number; // velocity
  vy: number;
  targetOpacity: number;
  colorIntensity: number; // random variation factor
}

export function TechyGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = 0;
    let height = 0;
    
    // Physics constants
    const repelRadius = 125; 
    const repelPower = 4.2;
    const springStrength = 0.08;
    const friction = 0.88;
    
    // Animation constants
    let thetaY = 0;
    let thetaX = 0;
    const speedY = 0.0035; // continuous orbital rotation speed around Y axis
    const speedX = 0.0008; // continuous orbital rotation speed around X axis

    // Mouse tracking parameters
    let mouseX = -9999;
    let mouseY = -9999;
    let isMouseOnCanvas = false;

    // List of particles representing the globe sphere
    const particles: Particle[] = [];
    const sphereRadius = 580; // visual size of the globe (50% wider and bigger)
    
    // Setup uniformly spaced particles on a sphere using Fibonacci distribution or Grid-latitude pattern
    // A uniform grid pattern is highly structured (looking more cybernetic, matching the grid of lines in the user image)
    const latRows = 18;
    for (let i = 1; i < latRows; i++) {
      const latAngle = (i * Math.PI) / latRows; // 0 to PI (latitude)
      const rRow = sphereRadius * Math.sin(latAngle); // radius of current horizontal circular horizontal ring
      const yVal = sphereRadius * Math.cos(latAngle); // visual Y coordinate
      
      // Determine columns based on the radius of circle at this level
      const rowCircumference = 2 * Math.PI * rRow;
      const colCount = Math.max(8, Math.floor(rowCircumference / 18)); // slightly denser columns
      
      for (let j = 0; j < colCount; j++) {
        const lonAngle = (j * 2 * Math.PI) / colCount; // longitude (0 to 2*PI)
        const xVal = rRow * Math.cos(lonAngle);
        const zVal = rRow * Math.sin(lonAngle);
        
        particles.push({
          xSpace: xVal,
          ySpace: yVal,
          zSpace: zVal,
          currX: 0,
          currY: 0,
          vx: 0,
          vy: 0,
          targetOpacity: 0.15 + (Math.random() * 0.3),
          colorIntensity: 0.6 + Math.random() * 0.4,
        });
      }
    }

    // Handle high DPI Retina displays for crisp vertical bars
    const resizeCanvas = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      width = rect.width;
      // Make it slightly taller to accommodate larger 580 radius
      height = Math.max(980, rect.height || 1000);

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      ctx.scale(dpr, dpr);
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Initial setup for positions so we don't start at (0,0)
    let isFirstFrame = true;

    // Mouse event listeners
    const handleWindowMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
      
      // Determine if mouse is within a hover bounding box region over the canvas
      if (
        e.clientX >= rect.left && 
        e.clientX <= rect.right && 
        e.clientY >= rect.top && 
        e.clientY <= rect.bottom
      ) {
        isMouseOnCanvas = true;
      } else {
        isMouseOnCanvas = false;
      }
    };

    const handleWindowMouseLeave = () => {
      mouseX = -9999;
      mouseY = -9999;
      isMouseOnCanvas = false;
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    document.addEventListener("mouseleave", handleWindowMouseLeave);

    // Core animation cycle
    const renderLoop = () => {
      ctx.clearRect(0, 0, width, height);

      // Sphere center coordinates inside canvas section
      const centerX = width / 2;
      const centerY = height / 2 + 280; // center is lowered visually so only the upper half of the globe crests upward behind the hero text

      // Slowly increment overall rotation angles
      thetaY += speedY;
      thetaX += speedX;

      const cosY = Math.cos(thetaY);
      const sinY = Math.sin(thetaY);
      const cosX = Math.cos(thetaX);
      const sinX = Math.sin(thetaX);

      // Group particles into depth so we can render from back-to-front for proper 3D sorting overlap
      const sortedParticles: { 
        part: Particle; 
        hx: number; 
        hy: number; 
        depthZ: number; 
        scaleFactor: number; 
      }[] = [];

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // 3D rotations:
        // Y-axis rotation first
        const yRotX = p.xSpace * cosY - p.zSpace * sinY;
        const yRotZ = p.xSpace * sinY + p.zSpace * cosY;

        // X-axis rotation of intermediate rotated system
        const xRotY = p.ySpace * cosX - yRotZ * sinX;
        const xRotZ = p.ySpace * sinX + yRotZ * cosX; // resulting depth coordinate (from -R to R)

        // Stereographic perspective coefficient
        // Closer particles (higher z coordinate) appear slightly larger, wider, and taller
        const scaleFactor = 0.78 + 0.34 * (xRotZ / sphereRadius);

        // Project centered target 2D location on screen
        const hx = centerX + yRotX * scaleFactor;
        const hy = centerY + xRotY * scaleFactor;

        // First initialization pass
        if (isFirstFrame) {
          p.currX = hx;
          p.currY = hy;
        }

        sortedParticles.push({
          part: p,
          hx,
          hy,
          depthZ: xRotZ,
          scaleFactor,
        });
      }

      isFirstFrame = false;

      // Sort by depth (render back of sphere first, then front)
      sortedParticles.sort((a, b) => a.depthZ - b.depthZ);

      // Perform physics calculations & draw
      for (let i = 0; i < sortedParticles.length; i++) {
        const item = sortedParticles[i];
        const p = item.part;
        const homeX = item.hx;
        const homeY = item.hy;

        // Reset forces with spring towards target home rotating point
        let fx = (homeX - p.currX) * springStrength;
        let fy = (homeY - p.currY) * springStrength;

        // Apply mouse repulse scatter force if within range
        if (isMouseOnCanvas && mouseX >= 0 && mouseY >= 0) {
          const dx = p.currX - mouseX;
          const dy = p.currY - mouseY;
          const distSq = dx * dx + dy * dy;
          const dist = Math.sqrt(distSq);

          if (dist < repelRadius && dist > 0.1) {
            // Repelling force scales up when closest
            const force = (repelRadius - dist) / repelRadius; // 0 to 1
            const dirX = dx / dist;
            const dirY = dy / dist;

            // Direct push factor
            fx += dirX * force * repelPower;
            fy += dirY * force * repelPower;
            
            // Add a slight tangential turbulence swirl for organic dispersal
            fx += -dirY * force * 1.5;
            fy += dirX * force * 1.5;
          }
        }

        // Apply movement forces to velocity
        p.vx += fx;
        p.vy += fy;

        // Friction dampening
        p.vx *= friction;
        p.vy *= friction;

        // Update coordinate positions
        p.currX += p.vx;
        p.currY += p.vy;

        // Visual attributes
        // Particles at the back (depthZ < 0) are smaller and faint
        // Particles at the front (depthZ > 0) are brighter, taller, and form glowing spots
        const normalizedZ = (item.depthZ + sphereRadius) / (2 * sphereRadius); // 0 to 1
        
        let opacity = normalizedZ * 0.7 + 0.1; 
        if (opacity < 0.1) opacity = 0.1;
        if (opacity > 0.9) opacity = 0.9;

        // Apply randomized intensity modifier
        opacity *= p.colorIntensity;

        // If mouse is near, let particles glow slightly or react
        const isMoused = isMouseOnCanvas && Math.pow(p.currX - mouseX, 2) + Math.pow(p.currY - mouseY, 2) < Math.pow(repelRadius, 2);
        
        // Base setup style: Vertical dash (matches the cyber-financial design in image)
        const barHeight = Math.max(3, 8 * item.scaleFactor);
        const barWidth = isMoused ? 1.5 : 1 + normalizedZ * 1.0;

        // Styling: Neon/Amber/Orange scheme mapping the color palette
        ctx.save();
        ctx.beginPath();
        
        // Create an orange gradient or varying level to make it glowing
        let colorString = `rgba(249, 115, 22, ${opacity})`; // brand orange
        
        if (isMoused) {
          // Glow intense white-to-orange during scattering
          colorString = `rgba(255, 165, 80, ${opacity * 1.1})`;
        } else if (normalizedZ > 0.8) {
          // Vibrant bright orange points at the front
          colorString = `rgba(251, 146, 60, ${opacity})`;
        } else if (normalizedZ < 0.3) {
          // Dimmer copper/crimson tones for distant back points to simulate dense spherical background
          colorString = `rgba(194, 65, 12, ${opacity * 0.75})`;
        }

        ctx.fillStyle = colorString;
        
        // Slightly rounded-sm vertical bars (dashes)
        ctx.fillRect(p.currX - barWidth / 2, p.currY - barHeight / 2, barWidth, barHeight);
        ctx.restore();
      }

      animationFrameId = requestAnimationFrame(renderLoop);
    };

    renderLoop();

    // Cleanup inside hook
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", resizeCanvas);
      window.removeEventListener("mousemove", handleWindowMouseMove);
      document.removeEventListener("mouseleave", handleWindowMouseLeave);
    };
  }, []);

  return (
    <div 
      ref={containerRef} 
      className="relative w-full max-w-[110rem] h-[980px] mx-auto flex items-center justify-center select-none cursor-default pointer-events-auto"
      id="techy-globe-container"
    >
      {/* Absolute Ambient Background Radial Glow strictly behind the globe canvas */}
      <div className="absolute -inset-20 rounded-full bg-gradient-to-tr from-panik-orange/15 via-transparent to-panik-orange/[0.05] opacity-65 blur-3xl pointer-events-none z-0"></div>
      
      {/* Canvas */}
      <canvas 
        ref={canvasRef} 
        className="relative z-10 block cursor-crosshair opacity-85 pointer-events-auto" 
        id="techy-globe-canvas"
      />
    </div>
  );
}
