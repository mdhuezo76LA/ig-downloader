"""InsightFace 0.7.3 inference, without reparsing a 554MB graph at runtime."""
import numpy as np
from insightface.model_zoo.inswapper import INSwapper


class BakedINSwapper(INSwapper):
    def __init__(self, model_file, session):
        # These are the upstream constructor's exact inference attributes.
        # emap was extracted from this checksum-verified ONNX at build time.
        # All face alignment, embedding projection, inference and paste-back
        # remain the original inherited InsightFace methods.
        self.model_file = model_file
        self.session = session
        self.emap = np.load(model_file.replace('.onnx', '.emap.npy'), allow_pickle=False)
        if self.emap.shape != (512, 512):
            raise ValueError(f'Invalid inswapper identity mapping: {self.emap.shape}')
        self.input_mean = 0.0
        self.input_std = 255.0
        inputs = session.get_inputs()
        self.input_names = [item.name for item in inputs]
        self.output_names = [item.name for item in session.get_outputs()]
        if len(inputs) != 2 or len(self.output_names) != 1:
            raise ValueError('Unexpected inswapper input/output signature')
        self.input_shape = inputs[0].shape
        self.input_size = tuple(self.input_shape[2:4][::-1])