#pragma once

#include "driver/adc.h"
#include "esp_adc_cal.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

class ADCReader {
public:
    ADCReader();
    ~ADCReader();
    void read_voltage_and_current(float& voltage, float& current);
    float read_throttle_pct();  // Read throttle position as percentage (0-100%)

private:
    void configure_adc();
    void init_timer();
    static void adc_timer_callback(void* arg);

    adc1_channel_t voltage_channel = ADC1_CHANNEL_1;
    adc1_channel_t current_channel = ADC1_CHANNEL_0;
    adc1_channel_t throttle_channel = ADC1_CHANNEL_3;  // GPIO 3 for throttle
    esp_adc_cal_characteristics_t adc_chars;
    esp_timer_handle_t periodic_timer;
    
    // Throttle calibration constants (voltage range)
    static constexpr float THROTTLE_MIN_VOLTAGE = 0.83f;   // 0% throttle
    static constexpr float THROTTLE_MAX_VOLTAGE = 3.33f;   // 100% throttle
    
    float cumulative_current = 0.0f;
    int current_reading_count = 0;
    uint32_t raw_current_reading = 0;
    
    SemaphoreHandle_t data_mutex;
};
