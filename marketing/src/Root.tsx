import React from 'react';
import {Composition} from 'remotion';
import {Loom, TOTAL} from './Loom';

export const Root: React.FC = () => (
  <Composition
    id="Loom"
    component={Loom}
    durationInFrames={TOTAL}
    fps={30}
    width={1920}
    height={1080}
  />
);
