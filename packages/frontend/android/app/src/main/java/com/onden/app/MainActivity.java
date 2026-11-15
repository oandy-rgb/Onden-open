package com.onden.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // In-app plugins register before the bridge starts (super.onCreate).
        registerPlugin(ShareIntentPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
